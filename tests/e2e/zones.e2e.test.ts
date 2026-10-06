import { randomBytes, randomUUID } from "node:crypto";
import {
  alertsResponseSchema,
  apiErrorSchema,
  batchAckSchema,
  DEVICE_TOKEN_PREFIX,
  deviceTokenSchema,
  sessionSchema,
  stoppedVehiclesResponseSchema,
  zoneFeatureCollectionSchema,
  zoneFeatureSchema,
  type ZoneFeature,
} from "@fleet/contracts";
import { hashPassword, loadConfig, sha256Hex } from "@fleet/platform";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import "./provided-context.js";
import { e2eConfigSchema } from "./support.js";

// Flujo e2e de las zonas creadas desde el dashboard (gateway, processor y fleet-api los levantó el arnés desde dist/): POST /v1/zones (sesión) ->
// zona en la base -> puntos detenidos de un vehículo dentro de ella, con fix GPS de más de 20 minutos (ALERT_CRITICAL_STOP_MINUTES), enviados por el
// gateway -> processor (consulta las zonas por lote, sin caché: la zona nueva aplica de inmediato) -> `GET /v1/vehicles/stopped?zoneKind=critical` y
// la alerta `critical_zone_stop` con esa zona. También: 409 por nombre repetido, 400 invalid_geometry, aislamiento entre tenants y 401 sin cookie.
// Los datos (tenants, usuarios, vehículos, dispositivos, zonas, puntos) son de esta corrida (`runId`) y se borran al terminar.
const fleetApiUrl = inject("fleetApiUrl");
const gatewayUrl = inject("gatewayUrl");
const runId = inject("runId");
const config = loadConfig(e2eConfigSchema);
const db = new Client({ connectionString: config.DATABASE_ADMIN_URL });

const CHEAP_SCRYPT = { N: 1_024, r: 8, p: 1 } as const;
const json = { "content-type": "application/json" };

interface Tenant {
  label: string;
  tenantId: string;
  vehicleId: string;
  deviceToken: string;
  email: string;
  password: string;
}

const tenantIds: string[] = [];

/** Una IP de documentación (192.0.2.0/24) distinta por llamada: ningún límite por IP se comparte entre tests. */
let ipCounter = 150;
const nextIp = () => `192.0.2.${ipCounter++}`;

// Rectángulo de ~1 km en Medellín (lon -75.57..-75.56, lat 6.25..6.26) y un punto dentro de él, con la longitud primero (regla 13).
const RING: [number, number][] = [
  [-75.57, 6.25],
  [-75.56, 6.25],
  [-75.56, 6.26],
  [-75.57, 6.26],
  [-75.57, 6.25],
];
const INSIDE = { lon: -75.565, lat: 6.255 };
const BOW_TIE: [number, number][] = [
  [-75.57, 6.25],
  [-75.56, 6.26],
  [-75.56, 6.25],
  [-75.57, 6.26],
  [-75.57, 6.25],
];

async function createTenant(label: string): Promise<Tenant> {
  const tenant: Tenant = {
    label,
    tenantId: randomUUID(),
    vehicleId: randomUUID(),
    deviceToken: deviceTokenSchema.parse(`${DEVICE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`),
    email: `e2e-zone-${runId}-${label}@flota.test`,
    password: randomBytes(18).toString("base64url"),
  };
  await db.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [tenant.tenantId, `e2e-zone-${runId}-${label}`]);
  tenantIds.push(tenant.tenantId);
  await db.query("INSERT INTO users (user_id, tenant_id, email, name, password_hash) VALUES ($1, $2, $3, $4, $5)", [
    randomUUID(),
    tenant.tenantId,
    tenant.email,
    `Operador zonas ${label} ${runId}`,
    await hashPassword(tenant.password, CHEAP_SCRYPT),
  ]);
  await db.query("INSERT INTO vehicles (id, tenant_id, plate) VALUES ($1, $2, $3)", [tenant.vehicleId, tenant.tenantId, `Z${tenant.vehicleId.slice(0, 5).toUpperCase()}`]);
  await db.query("INSERT INTO devices (id, tenant_id, vehicle_id, token_hash) VALUES ($1, $2, $3, $4)", [
    randomUUID(),
    tenant.tenantId,
    tenant.vehicleId,
    sha256Hex(tenant.deviceToken),
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

const zoneBody = (name: string, kind: string, ring: [number, number][] = RING) => ({ name, kind, geometry: { type: "Polygon", coordinates: [ring] } });
const createZone = (cookie: string | undefined, body: unknown) => call("/v1/zones", { method: "POST", ...(cookie !== undefined && { cookie }), body });
const zonesOf = async (cookie: string) => zoneFeatureCollectionSchema.parse(await (await call("/v1/zones/geojson", { cookie })).json());

// Los puntos van fechados HACIA ATRÁS (hace 70 a 45 minutos): dentro de la antigüedad que acepta el gateway, sin esperar 20 minutos de verdad;
// la detención se calcula con la hora del fix (25 minutos > ALERT_CRITICAL_STOP_MINUTES).
const RUN_START_MS = Date.now();
const minutesAgo = (minutes: number) => new Date(RUN_START_MS - minutes * 60_000).toISOString();
const rangeFrom = () => new Date(RUN_START_MS - 3 * 3_600_000);
const rangeTo = () => new Date(Date.now() + 3_600_000);

const pointOf = (tenant: Tenant, recordedAt: string) => ({
  eventId: randomUUID(),
  vehicleId: tenant.vehicleId,
  recordedAt,
  lon: INSIDE.lon,
  lat: INSIDE.lat,
  speedMps: 0,
  headingDeg: 90,
  accuracyM: 6,
  mocked: false,
  lowAccuracy: false,
});

async function postStoppedPoints(tenant: Tenant): Promise<void> {
  const points = [70, 65, 60, 55, 50, 45].map((ago) => pointOf(tenant, minutesAgo(ago)));
  const response = await fetch(`${gatewayUrl}/v1/telemetry/batches`, {
    method: "POST",
    headers: { ...json, authorization: `Bearer ${tenant.deviceToken}`, "x-correlation-id": `e2e-${runId}-zone-${tenant.label}` },
    body: JSON.stringify({ schemaVersion: 1, sentAt: new Date().toISOString(), points }),
  });
  expect(response.status).toBe(202);
  const ack = batchAckSchema.parse(await response.json());
  expect(ack.accepted).toEqual(points.map((point) => point.eventId));
  expect(ack.rejected).toEqual([]);
}

/** Espera por sondeo, nunca con un sleep fijo. */
async function waitFor<T>(what: string, probe: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 40_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await probe();
    if (result !== undefined && result !== false) return result;
    if (Date.now() > deadline) throw new Error(`Se agotaron ${timeoutMs} ms esperando: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

let norte: Tenant;
let sur: Tenant;
let norteCookie: string;
let surCookie: string;

beforeAll(async () => {
  await db.connect();
  norte = await createTenant("norte");
  sur = await createTenant("sur");
  norteCookie = await sessionOf(norte);
  surCookie = await sessionOf(sur);
});

afterAll(async () => {
  if (tenantIds.length > 0) {
    // Orden de las claves foráneas: alertas, estado, zonas, telemetría, dispositivos, usuarios, vehículos, tenants.
    const by = (sql: string, params: unknown[] = [tenantIds]) => db.query(sql, params).catch(() => undefined);
    await by("DELETE FROM alerts WHERE tenant_id = ANY($1::uuid[])");
    await by("DELETE FROM vehicle_state WHERE tenant_id = ANY($1::uuid[])");
    await by("DELETE FROM zones WHERE tenant_id = ANY($1::uuid[])");
    await by("DELETE FROM telemetry WHERE tenant_id = ANY($1::uuid[]) AND recorded_at >= $2 AND recorded_at < $3", [tenantIds, rangeFrom(), rangeTo()]);
    await by("DELETE FROM devices WHERE tenant_id = ANY($1::uuid[])");
    await by("DELETE FROM users WHERE tenant_id = ANY($1::uuid[])");
    await by("DELETE FROM vehicles WHERE tenant_id = ANY($1::uuid[])");
    await by("DELETE FROM tenants WHERE id = ANY($1::uuid[])");
  }
  await db.end().catch(() => undefined);
});

describe("POST /v1/zones -> zona -> processor -> vehículos detenidos y alerta contra el stack real", () => {
  let zone: ZoneFeature;

  it(
    "crear una zona crítica y enviar puntos detenidos de >20 min dentro de ella: aparece en /v1/vehicles/stopped?zoneKind=critical y salta critical_zone_stop con esa zona",
    async () => {
      const response = await createZone(norteCookie, zoneBody(`Zona crítica e2e ${runId}`, "critical"));

      expect(response.status).toBe(201);
      zone = zoneFeatureSchema.parse(await response.json());
      expect(zone.properties).toMatchObject({ name: `Zona crítica e2e ${runId}`, kind: "critical" });
      expect(await zonesOf(norteCookie)).toMatchObject({ features: [{ properties: zone.properties }] });

      await postStoppedPoints(norte);

      const stopped = await waitFor("el vehículo en /v1/vehicles/stopped?zoneKind=critical", async () => {
        const body = stoppedVehiclesResponseSchema.parse(await (await call("/v1/vehicles/stopped?zoneKind=critical&minMinutes=20", { cookie: norteCookie })).json());
        return body.items.find((item) => item.zone?.zoneId === zone.properties.zoneId);
      });
      expect(stopped.stoppedMinutes).toBeGreaterThanOrEqual(20);
      expect(stopped.zone).toEqual(zone.properties);

      const alert = await waitFor("la alerta critical_zone_stop de la zona en /v1/alerts", async () => {
        const body = alertsResponseSchema.parse(await (await call("/v1/alerts?status=all&limit=200", { cookie: norteCookie })).json());
        return body.items.find((item) => item.type === "critical_zone_stop" && item.zoneId === zone.properties.zoneId);
      });
      expect(alert).toMatchObject({ vehicleId: norte.vehicleId, zoneName: zone.properties.name, resolvedAt: null });
    },
    90_000,
  );

  it("un nombre repetido en el tenant responde 409 zone_name_taken, aunque cambien el tipo y la forma; en otro tenant el mismo nombre es válido", async () => {
    const name = `Repetida e2e ${runId}`;
    expect((await createZone(norteCookie, zoneBody(name, "depot"))).status).toBe(201);

    const duplicate = await createZone(norteCookie, zoneBody(name, "customer", RING.map(([lng, lat]) => [lng + 0.1, lat] as [number, number])));

    expect(duplicate.status).toBe(409);
    expect(apiErrorSchema.parse(await duplicate.json()).error.code).toBe("zone_name_taken");
    expect((await createZone(surCookie, zoneBody(name, "depot"))).status).toBe(201);
  });

  it("un polígono que se cruza consigo mismo responde 400 invalid_geometry, y uno que no cumple el esquema, 400 invalid_request; ninguno se guarda", async () => {
    const before = (await zonesOf(norteCookie)).features.length;

    const bowTie = await createZone(norteCookie, zoneBody(`Moño e2e ${runId}`, "critical", BOW_TIE));
    const outside = await createZone(norteCookie, zoneBody(`Madrid e2e ${runId}`, "critical", RING.map(([lng, lat]) => [lng + 71, lat + 34] as [number, number])));

    expect(bowTie.status).toBe(400);
    expect(apiErrorSchema.parse(await bowTie.json()).error.code).toBe("invalid_geometry");
    expect(outside.status).toBe(400);
    expect(apiErrorSchema.parse(await outside.json()).error.code).toBe("invalid_request");
    expect((await zonesOf(norteCookie)).features).toHaveLength(before);
  });

  it("aislamiento: el tenant B no ve la zona de A en /v1/zones/geojson, y un tenantId del cuerpo no mueve la zona de tenant", async () => {
    const name = `Solo de A e2e ${runId}`;
    const created = await createZone(norteCookie, { ...zoneBody(name, "customer", RING.map(([lng, lat]) => [lng - 0.2, lat] as [number, number])), tenantId: sur.tenantId });
    expect(created.status).toBe(201);
    const { zoneId } = zoneFeatureSchema.parse(await created.json()).properties;

    expect((await zonesOf(norteCookie)).features.some((feature) => feature.properties.zoneId === zoneId)).toBe(true);
    expect((await zonesOf(surCookie)).features.some((feature) => feature.properties.zoneId === zoneId)).toBe(false);
    const owner = await db.query<{ tenant_id: string }>("SELECT tenant_id FROM zones WHERE zone_id = $1", [zoneId]);
    expect(owner.rows[0]?.tenant_id).toBe(norte.tenantId);
  });

  it("sin cookie responde 401 y no crea nada", async () => {
    const name = `Sin sesion e2e ${runId}`;

    const response = await createZone(undefined, zoneBody(name, "critical"));

    expect(response.status).toBe(401);
    const count = await db.query<{ n: string }>("SELECT count(*) AS n FROM zones WHERE name = $1", [name]);
    expect(Number(count.rows[0]?.n)).toBe(0);
  });
});
