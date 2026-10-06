import { randomBytes, randomUUID } from "node:crypto";
import {
  apiErrorSchema,
  devicePairResponseSchema,
  pairingCodeSchema,
  sessionSchema,
  userListResponseSchema,
  vehicleCatalogItemSchema,
  vehicleListResponseSchema,
} from "@fleet/contracts";
import { hashPassword, loadConfig } from "@fleet/platform";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import "./provided-context.js";
import { e2eConfigSchema } from "./support.js";

// Flujo e2e del catálogo de vehículos (fleet-api levantado por el arnés desde dist/): alta -> catálogo con hasActiveDevice:false -> código de
// vinculación -> canje -> hasActiveDevice:true, el 409 por placa repetida, el listado de usuarios y el aislamiento entre tenants. Los datos
// (tenants, usuarios, vehículos) son de esta corrida (`runId`) y se borran al terminar.
const fleetApiUrl = inject("fleetApiUrl");
const runId = inject("runId");
const config = loadConfig(e2eConfigSchema);
const db = new Client({ connectionString: config.DATABASE_ADMIN_URL });

const CHEAP_SCRYPT = { N: 1_024, r: 8, p: 1 } as const;
const json = { "content-type": "application/json" };

interface Tenant {
  label: string;
  tenantId: string;
  userId: string;
  email: string;
  password: string;
  userName: string;
}

const tenantIds: string[] = [];

/** Una IP de documentación (192.0.2.0/24) distinta por llamada: ningún límite por IP se comparte entre tests. */
let ipCounter = 100;
const nextIp = () => `192.0.2.${ipCounter++}`;

async function createTenant(label: string): Promise<Tenant> {
  const tenant: Tenant = {
    label,
    tenantId: randomUUID(),
    userId: randomUUID(),
    email: `e2e-cat-${runId}-${label}@flota.test`,
    password: randomBytes(18).toString("base64url"),
    userName: `Operador catalogo ${label} ${runId}`,
  };
  await db.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [tenant.tenantId, `e2e-cat-${runId}-${label}`]);
  tenantIds.push(tenant.tenantId);
  await db.query("INSERT INTO users (user_id, tenant_id, email, name, password_hash) VALUES ($1, $2, $3, $4, $5)", [
    tenant.userId,
    tenant.tenantId,
    tenant.email,
    tenant.userName,
    await hashPassword(tenant.password, CHEAP_SCRYPT),
  ]);
  return tenant;
}

async function sessionOf(tenant: Tenant): Promise<string> {
  const response = await fetch(`${fleetApiUrl}/v1/auth/login`, {
    method: "POST",
    headers: { ...json, "x-forwarded-for": nextIp() },
    body: JSON.stringify({ email: tenant.email, password: tenant.password }),
  });
  expect(response.status).toBe(200);
  sessionSchema.parse(await response.json());
  const setCookie = response.headers.getSetCookie().find((cookie) => cookie.startsWith("fleet_session="));
  if (setCookie === undefined) throw new Error("el login no dejó la cookie");
  return setCookie.split(";", 1)[0] ?? "";
}

const call = (path: string, init: { method?: string; cookie?: string; body?: unknown } = {}) =>
  fetch(`${fleetApiUrl}${path}`, {
    method: init.method ?? "GET",
    headers: { ...(init.body !== undefined && json), ...(init.cookie !== undefined && { cookie: init.cookie }), "x-forwarded-for": nextIp() },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  });

const createVehicle = (cookie: string | undefined, body: unknown) => call("/v1/vehicles", { method: "POST", ...(cookie !== undefined && { cookie }), body });
const listVehicles = async (cookie: string) => vehicleListResponseSchema.parse(await (await call("/v1/vehicles?limit=500", { cookie })).json());

let norte: Tenant;
let sur: Tenant;
let norteCookie: string;
let surCookie: string;
const plateOf = (suffix: string) => `E${runId.replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toUpperCase()}${suffix}`;

beforeAll(async () => {
  await db.connect();
  norte = await createTenant("norte");
  sur = await createTenant("sur");
  norteCookie = await sessionOf(norte);
  surCookie = await sessionOf(sur);
});

afterAll(async () => {
  if (tenantIds.length > 0) {
    const by = (table: string, column = "tenant_id") => db.query(`DELETE FROM ${table} WHERE ${column} = ANY($1::uuid[])`, [tenantIds]).catch(() => undefined);
    await by("device_pairing_codes");
    await by("devices");
    await by("users");
    await by("vehicles");
    await by("tenants", "id");
  }
  await db.end().catch(() => undefined);
});

describe("catálogo de vehículos: alta y vinculación", () => {
  it("crear -> aparece en el catálogo sin dispositivo -> código -> canje -> hasActiveDevice:true", async () => {
    const plate = plateOf("A1");
    const created = await createVehicle(norteCookie, { plate: plate.toLowerCase(), label: "  Camión e2e  " });

    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    const vehicle = vehicleCatalogItemSchema.parse(await created.json());
    expect(vehicle).toMatchObject({ plate, label: "Camión e2e", hasActiveDevice: false });

    const before = (await listVehicles(norteCookie)).items.find((item) => item.vehicleId === vehicle.vehicleId);
    expect(before).toEqual(vehicle);
    // Sin ninguna fila de telemetría ni de estado: el catálogo no depende de ellas.
    expect((await db.query("SELECT 1 FROM vehicle_state WHERE vehicle_id = $1", [vehicle.vehicleId])).rowCount).toBe(0);

    const codeResponse = await call("/v1/devices/pairing-codes", { method: "POST", cookie: norteCookie, body: { vehicleId: vehicle.vehicleId } });
    expect(codeResponse.status).toBe(201);
    const code = pairingCodeSchema.parse(await codeResponse.json());

    const paired = await call("/v1/devices/pair", { method: "POST", body: { code: code.code } });
    expect(paired.status).toBe(201);
    expect(devicePairResponseSchema.parse(await paired.json()).vehicleId).toBe(vehicle.vehicleId);

    const after = (await listVehicles(norteCookie)).items.find((item) => item.vehicleId === vehicle.vehicleId);
    expect(after).toMatchObject({ plate, hasActiveDevice: true });
  });

  it("una placa repetida en el tenant responde 409 plate_taken sin la placa; la misma placa en otro tenant es válida", async () => {
    const plate = plateOf("B2");
    expect((await createVehicle(norteCookie, { plate })).status).toBe(201);

    const duplicate = await createVehicle(norteCookie, { plate: plate.toLowerCase() });

    expect(duplicate.status).toBe(409);
    const text = await duplicate.text();
    expect(apiErrorSchema.parse(JSON.parse(text)).error.code).toBe("plate_taken");
    expect(text).not.toContain(plate);
    expect((await createVehicle(surCookie, { plate })).status).toBe(201);
  });

  it("un cuerpo inválido responde 400 y no crea nada; un tenantId del cuerpo se ignora", async () => {
    for (const body of [{}, { plate: "AB CD" }, { plate: "" }, { plate: "A".repeat(33) }, { plate: "ABC123", label: "x".repeat(65) }]) {
      const response = await createVehicle(norteCookie, body);
      expect(response.status).toBe(400);
      expect(apiErrorSchema.parse(await response.json()).error.code).toBe("invalid_request");
    }
    const plate = plateOf("C3");
    const created = await createVehicle(norteCookie, { plate, tenantId: sur.tenantId });

    expect(created.status).toBe(201);
    const stored = await db.query<{ tenant_id: string }>("SELECT tenant_id FROM vehicles WHERE id = $1", [vehicleCatalogItemSchema.parse(await created.json()).vehicleId]);
    expect(stored.rows[0]?.tenant_id).toBe(norte.tenantId);
  });
});

describe("catálogo y usuarios: aislamiento entre tenants y autenticación", () => {
  it("el tenant B no ve los vehículos ni los usuarios del A, y viceversa", async () => {
    const plate = plateOf("D4");
    const created = vehicleCatalogItemSchema.parse(await (await createVehicle(norteCookie, { plate })).json());

    const surVehicles = await listVehicles(surCookie);
    expect(surVehicles.items.some((item) => item.vehicleId === created.vehicleId)).toBe(false);
    expect((await listVehicles(norteCookie)).items.some((item) => item.vehicleId === created.vehicleId)).toBe(true);

    // El tenant B tampoco puede pedir un código para un vehículo de A: 404 como si no existiera.
    const foreign = await call("/v1/devices/pairing-codes", { method: "POST", cookie: surCookie, body: { vehicleId: created.vehicleId } });
    expect(foreign.status).toBe(404);

    const norteUsers = userListResponseSchema.parse(await (await call("/v1/users", { cookie: norteCookie })).json());
    const surUsers = userListResponseSchema.parse(await (await call("/v1/users", { cookie: surCookie })).json());
    expect(norteUsers.items.map((user) => user.userId)).toEqual([norte.userId]);
    expect(surUsers.items.map((user) => user.userId)).toEqual([sur.userId]);
    expect(norteUsers.items[0]).toMatchObject({ name: norte.userName, email: norte.email });
  });

  it("el listado de usuarios no incluye el hash de la contraseña", async () => {
    const text = await (await call("/v1/users", { cookie: norteCookie })).text();

    expect(text).not.toMatch(/scrypt|password/i);
  });

  it("sin cookie (o con una inválida) las tres rutas responden 401", async () => {
    expect((await call("/v1/vehicles")).status).toBe(401);
    expect((await call("/v1/users")).status).toBe(401);
    expect((await createVehicle(undefined, { plate: plateOf("E5") })).status).toBe(401);
    expect((await call("/v1/vehicles", { cookie: "fleet_session=basura" })).status).toBe(401);
    expect((await db.query("SELECT 1 FROM vehicles WHERE plate = $1", [plateOf("E5")])).rowCount).toBe(0);
  });

  it("limit fuera de rango responde 400", async () => {
    expect((await call("/v1/vehicles?limit=501", { cookie: norteCookie })).status).toBe(400);
    expect((await call("/v1/users?limit=0", { cookie: norteCookie })).status).toBe(400);
  });
});
