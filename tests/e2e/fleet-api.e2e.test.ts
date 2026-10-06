import { randomBytes, randomInt, randomUUID } from "node:crypto";
import {
  alertsResponseSchema,
  apiErrorSchema,
  batchAckSchema,
  DEVICE_TOKEN_PREFIX,
  devicePairResponseSchema,
  deviceTokenSchema,
  fleetSummarySchema,
  pairingCodeSchema,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  sessionSchema,
  stoppedVehiclesResponseSchema,
  zoneFeatureCollectionSchema,
} from "@fleet/contracts";
import { hashPassword, loadConfig, sha256Hex } from "@fleet/platform";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { z } from "zod";
import { E2E_LOGIN_FAILURE_LIMIT_MAX, E2E_PAIR_FAILURE_LIMIT_MAX } from "./harness.js";
import "./provided-context.js";
import { e2eConfigSchema } from "./support.js";

// Flujo e2e de fleet-api (fleet-api, ingest-gateway y processor los levantó el arnés desde dist/): sesión por cookie, aislamiento entre tenants,
// la pregunta B1 de punta a punta (gateway -> Kafka -> processor -> base -> GET /v1/vehicles/stopped) y la vinculación de un dispositivo (código ->
// canje -> token que el gateway acepta). Los datos (tenants, usuarios, vehículos, zonas) son de esta corrida y se borran al terminar.
const fleetApiUrl = inject("fleetApiUrl");
const gatewayUrl = inject("gatewayUrl");
const runId = inject("runId");
const config = loadConfig(e2eConfigSchema);
// Solo el login de los usuarios sembrados (`pnpm db:seed`) necesita esta contraseña; su falta falla ese test con un mensaje claro.
const seedConfig = loadConfig(z.object({ SEED_USER_PASSWORD: z.string().min(12) }));

const db = new Client({ connectionString: config.DATABASE_ADMIN_URL });

// Parámetros baratos de scrypt: el login verifica con los que trae el hash.
const CHEAP_SCRYPT = { N: 1_024, r: 8, p: 1 } as const;

// Rectángulo de ~1 km en Medellín (lon -75.57..-75.56, lat 6.25..6.26): la zona CRÍTICA del tenant A, y un punto dentro (longitud primero).
const ZONE_A = "POLYGON((-75.57 6.25, -75.56 6.25, -75.56 6.26, -75.57 6.26, -75.57 6.25))";
const INSIDE_A = { lon: -75.565, lat: 6.255 };
// Rectángulo en Bogotá: la zona CRÍTICA del tenant B.
const ZONE_B = "POLYGON((-74.075 4.705, -74.065 4.705, -74.065 4.715, -74.075 4.715, -74.075 4.705))";
const INSIDE_B = { lon: -74.07, lat: 4.71 };

interface Tenant {
  label: string;
  tenantId: string;
  userId: string;
  email: string;
  password: string;
  zoneId: string;
  zoneName: string;
  /** Vehículos del tenant por rol. */
  vehicles: Record<string, { id: string; plate: string }>;
}

const tenantIds: string[] = [];
const vehicleIds: string[] = [];

// Instante fijo de la corrida: el mismo "hace 70 minutos" en cada llamada (con Date.now() cambiaría de milisegundo y el stoppedSince no coincidiría).
const RUN_START_MS = Date.now();
const minutesAgo = (minutes: number) => new Date(RUN_START_MS - minutes * 60_000);

/** Una IP de documentación (192.0.2.0/24) distinta por llamada: ningún límite por IP se comparte entre tests. */
let ipCounter = 10;
const nextIp = () => `192.0.2.${ipCounter++}`;

async function createTenant(label: string, zoneWkt: string, roles: string[]): Promise<Tenant> {
  const tenantId = randomUUID();
  const userId = randomUUID();
  const zoneId = randomUUID();
  const password = randomBytes(18).toString("base64url");
  const email = `e2e-${runId}-${label}@flota.test`;
  const zoneName = `Zona crítica ${label} ${runId}`;
  await db.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [tenantId, `e2e-${runId}-${label}`]);
  tenantIds.push(tenantId);
  await db.query("INSERT INTO users (user_id, tenant_id, email, name, password_hash) VALUES ($1, $2, $3, $4, $5)", [
    userId,
    tenantId,
    email,
    `Operador ${label}`,
    await hashPassword(password, CHEAP_SCRYPT),
  ]);
  await db.query("INSERT INTO zones (zone_id, tenant_id, name, kind, geom) VALUES ($1, $2, $3, 'critical', ST_GeomFromText($4, 4326))", [zoneId, tenantId, zoneName, zoneWkt]);
  const vehicles: Tenant["vehicles"] = {};
  for (const role of roles) {
    const id = randomUUID();
    const plate = `E${id.slice(0, 5).toUpperCase()}`;
    await db.query("INSERT INTO vehicles (id, tenant_id, plate) VALUES ($1, $2, $3)", [id, tenantId, plate]);
    vehicleIds.push(id);
    vehicles[role] = { id, plate };
  }
  return { label, tenantId, userId, email, password, zoneId, zoneName, vehicles };
}

function vehicleOf(tenant: Tenant, role: string): { id: string; plate: string } {
  const vehicle = tenant.vehicles[role];
  if (vehicle === undefined) throw new Error(`El tenant ${tenant.label} no tiene el vehículo ${role}`);
  return vehicle;
}

async function createDevice(tenant: Tenant, vehicleId: string): Promise<string> {
  const token = deviceTokenSchema.parse(`${DEVICE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`);
  await db.query("INSERT INTO devices (id, tenant_id, vehicle_id, token_hash) VALUES ($1, $2, $3, $4)", [randomUUID(), tenant.tenantId, vehicleId, sha256Hex(token)]);
  return token;
}

async function seedState(
  tenant: Tenant,
  vehicleId: string,
  options: { movement: "moving" | "stopped"; stoppedSince?: Date; receivedAt: Date; zoneIds?: string[]; at: { lon: number; lat: number } },
): Promise<void> {
  await db.query(
    `INSERT INTO vehicle_state (vehicle_id, tenant_id, geom, recorded_at, received_at, speed_mps, heading_deg, movement, stopped_since, zone_ids, mocked, low_accuracy)
     VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326), $5, $5, 0, NULL, $6, $7, $8::uuid[], false, false)`,
    [vehicleId, tenant.tenantId, options.at.lon, options.at.lat, options.receivedAt, options.movement, options.stoppedSince ?? null, options.zoneIds ?? []],
  );
}

async function seedAlert(tenant: Tenant, vehicleId: string, zoneId: string | null): Promise<string> {
  const alertId = randomUUID();
  await db.query("INSERT INTO alerts (alert_id, tenant_id, vehicle_id, type, zone_id, started_at, raised_at) VALUES ($1, $2, $3, 'critical_zone_stop', $4, $5, $6)", [
    alertId,
    tenant.tenantId,
    vehicleId,
    zoneId,
    minutesAgo(40),
    minutesAgo(20),
  ]);
  return alertId;
}

let norte: Tenant;
let sur: Tenant;

beforeAll(async () => {
  await db.connect();
  // Norte (tenant A): vehículos del flujo B1 (`b1`), de la vinculación (`pairing`), uno en movimiento y otro detenido pero sin señal.
  norte = await createTenant("norte", ZONE_A, ["b1", "pairing", "moving", "stale"]);
  // Sur (tenant B): un vehículo detenido hace una hora, en SU zona crítica, con una alerta activa.
  sur = await createTenant("sur", ZONE_B, ["stopped"]);
  await seedState(norte, vehicleOf(norte, "moving").id, { movement: "moving", receivedAt: minutesAgo(1), at: INSIDE_A });
  // Detenido hace 3 horas pero su último mensaje llegó hace 1 hora: sin señal, no debe aparecer entre los detenidos.
  await seedState(norte, vehicleOf(norte, "stale").id, { movement: "stopped", stoppedSince: minutesAgo(180), receivedAt: minutesAgo(60), zoneIds: [norte.zoneId], at: INSIDE_A });
  await seedState(sur, vehicleOf(sur, "stopped").id, { movement: "stopped", stoppedSince: minutesAgo(60), receivedAt: minutesAgo(1), zoneIds: [sur.zoneId], at: INSIDE_B });
  await seedAlert(sur, vehicleOf(sur, "stopped").id, sur.zoneId);
});

afterAll(async () => {
  // Limpieza de los datos de esta corrida, en el orden de las claves foráneas.
  if (tenantIds.length > 0) {
    const by = (table: string, column = "tenant_id") => db.query(`DELETE FROM ${table} WHERE ${column} = ANY($1::uuid[])`, [tenantIds]).catch(() => undefined);
    await by("device_pairing_codes");
    await by("alerts");
    await by("vehicle_state");
    await by("zones");
    await db
      .query("DELETE FROM telemetry WHERE tenant_id = ANY($1::uuid[]) AND recorded_at >= $2 AND recorded_at < $3", [tenantIds, minutesAgo(180), new Date(Date.now() + 3_600_000)])
      .catch(() => undefined);
    await by("devices");
    await by("users");
    await by("vehicles");
    await by("tenants", "id");
  }
  await db.end().catch(() => undefined);
});

/** Espera por sondeo, nunca con un sleep fijo. */
async function waitFor<T>(what: string, probe: () => Promise<T | undefined | false>, timeoutMs = 40_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await probe();
    if (result !== undefined && result !== false) return result;
    if (Date.now() > deadline) throw new Error(`Se agotaron ${timeoutMs} ms esperando: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const json = { "content-type": "application/json" };

interface Session {
  /** `fleet_session=...`, listo para el header `cookie`. */
  cookie: string;
  setCookie: string;
}

async function login(email: string, password: string, ip = nextIp()): Promise<{ response: Response; session?: Session }> {
  const response = await fetch(`${fleetApiUrl}/v1/auth/login`, { method: "POST", headers: { ...json, "x-forwarded-for": ip }, body: JSON.stringify({ email, password }) });
  const setCookie = response.headers.getSetCookie().find((cookie) => cookie.startsWith("fleet_session="));
  return { response, ...(setCookie !== undefined && { session: { cookie: setCookie.split(";", 1)[0] ?? "", setCookie } }) };
}

async function sessionOf(tenant: Tenant): Promise<Session> {
  const { response, session } = await login(tenant.email, tenant.password);
  expect(response.status).toBe(200);
  if (session === undefined) throw new Error("el login no dejó la cookie");
  return session;
}

const get = (path: string, session?: Session) => fetch(`${fleetApiUrl}${path}`, { ...(session !== undefined && { headers: { cookie: session.cookie } }) });

describe("sesión con los usuarios sembrados", () => {
  it("el login de operador@norte.test deja la cookie fleet_session y la sesión del contrato; las credenciales malas dan 401", async () => {
    const { response, session } = await login("operador@norte.test", seedConfig.SEED_USER_PASSWORD);

    expect(response.status, "¿corriste `pnpm db:seed`? El usuario sembrado no inició sesión").toBe(200);
    const body = sessionSchema.parse(await response.json());
    expect(body.user).toMatchObject({ email: "operador@norte.test" });
    expect(body.tenant).toEqual({ tenantId: "f1ee7000-0000-4000-8000-000000000001", name: "Flota Norte" });
    expect(session?.setCookie).toMatch(/HttpOnly/i);
    expect(session?.setCookie).toMatch(/SameSite=Lax/i);
    expect(session?.setCookie).toMatch(/Path=\//);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const check = await get("/v1/auth/session", session);
    expect(check.status).toBe(200);
    expect(sessionSchema.parse(await check.json())).toEqual(body);

    const wrongPassword = await login("operador@norte.test", `${seedConfig.SEED_USER_PASSWORD}-mala`);
    expect(wrongPassword.response.status).toBe(401);
    expect(wrongPassword.session).toBeUndefined();
    const unknownEmail = await login("nadie@norte.test", "x".repeat(12));
    expect(unknownEmail.response.status).toBe(401);
    // El mismo 401 para "no existe" y "contraseña incorrecta".
    expect(await unknownEmail.response.json()).toEqual(await wrongPassword.response.json());
  });

  it("el login de un usuario de esta corrida es insensible a mayúsculas; el logout borra la cookie y sin cookie la API responde 401", async () => {
    const { response, session } = await login(norte.email.toUpperCase(), norte.password);

    expect(response.status).toBe(200);
    expect(sessionSchema.parse(await response.json()).user.userId).toBe(norte.userId);

    const logout = await fetch(`${fleetApiUrl}/v1/auth/logout`, { method: "POST", headers: { cookie: session?.cookie ?? "" } });
    expect(logout.status).toBe(204);
    expect(logout.headers.getSetCookie().join(";")).toMatch(/fleet_session=;/);
    expect((await get("/v1/auth/session")).status).toBe(401);
    expect((await get("/v1/auth/session", { cookie: "fleet_session=basura", setCookie: "" })).status).toBe(401);
  });

  it("tras N fallos desde una IP el login responde 429 con Retry-After, y otra IP no se ve afectada", async () => {
    const attacker = nextIp();

    for (let i = 0; i < E2E_LOGIN_FAILURE_LIMIT_MAX; i++) {
      expect((await login(`intruso-${i}-${randomUUID()}@flota.test`, "x".repeat(12), attacker)).response.status).toBe(401);
    }
    const blocked = await login(`intruso-final-${randomUUID()}@flota.test`, "x".repeat(12), attacker);

    expect(blocked.response.status).toBe(429);
    expect(apiErrorSchema.parse(await blocked.response.json()).error.code).toBe("rate_limited");
    expect(Number(blocked.response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await login(norte.email, norte.password, nextIp())).response.status).toBe(200);
  });

  it("CORS: el origen de la web recibe Allow-Credentials y su propio origen; otro origen no recibe Allow-Origin", async () => {
    const allowed = await fetch(`${fleetApiUrl}/health`, { headers: { origin: "http://localhost:3000" } });
    const denied = await fetch(`${fleetApiUrl}/health`, { headers: { origin: "http://evil.test" } });

    expect(allowed.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(allowed.headers.get("access-control-allow-credentials")).toBe("true");
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("B1 de punta a punta: gateway -> Kafka -> processor -> base -> fleet-api", () => {
  it(
    "un vehículo detenido más de 20 minutos en una zona crítica aparece en GET /v1/vehicles/stopped?minMinutes=20&zoneKind=critical de SU tenant, con su alerta, y no en el otro",
    async () => {
      const vehicle = vehicleOf(norte, "b1");
      const token = await createDevice(norte, vehicle.id);
      const point = (ago: number, speedMps: number) => ({
        eventId: randomUUID(),
        vehicleId: vehicle.id,
        recordedAt: minutesAgo(ago).toISOString(),
        ...INSIDE_A,
        speedMps,
        headingDeg: 90,
        accuracyM: 6,
        mocked: false,
        lowAccuracy: false,
      });
      // Un punto en movimiento y seis detenidos dentro de la zona, de hace 70 a hace 45 minutos (25 min detenido): se fechan HACIA ATRÁS para no esperar 20 minutos.
      const stoppedSince = minutesAgo(70);
      const points = [point(80, 9), ...[70, 65, 60, 55, 50, 45].map((ago) => point(ago, 0))];
      const response = await fetch(`${gatewayUrl}/v1/telemetry/batches`, {
        method: "POST",
        headers: { ...json, authorization: `Bearer ${token}`, "x-correlation-id": `e2e-${runId}-b1` },
        body: JSON.stringify({ schemaVersion: 1, sentAt: new Date().toISOString(), points }),
      });
      expect(response.status).toBe(202);
      expect(batchAckSchema.parse(await response.json()).accepted).toEqual(points.map((p) => p.eventId));

      const session = await sessionOf(norte);
      const found = await waitFor("el vehículo en /v1/vehicles/stopped (tenant Norte)", async () => {
        const body = stoppedVehiclesResponseSchema.parse(await (await get("/v1/vehicles/stopped?minMinutes=20&zoneKind=critical", session)).json());
        return body.items.find((item) => item.vehicleId === vehicle.id);
      });

      expect(found).toMatchObject({
        vehicleId: vehicle.id,
        plate: vehicle.plate,
        stoppedSince: stoppedSince.toISOString(),
        lon: INSIDE_A.lon,
        lat: INSIDE_A.lat,
        zone: { zoneId: norte.zoneId, name: norte.zoneName, kind: "critical" },
      });
      // Detenido desde hace 70 min contra la hora del fix GPS (no la del servidor).
      expect(found.stoppedMinutes).toBeGreaterThanOrEqual(70);
      expect(found.stoppedMinutes).toBeLessThan(75);

      // Los filtros: con un mínimo mayor (120) no aparece; con otro tipo de zona (depot) tampoco.
      const tooLong = stoppedVehiclesResponseSchema.parse(await (await get("/v1/vehicles/stopped?minMinutes=120", session)).json());
      expect(tooLong.items.map((item) => item.vehicleId)).not.toContain(vehicle.id);
      const depot = stoppedVehiclesResponseSchema.parse(await (await get("/v1/vehicles/stopped?minMinutes=20&zoneKind=depot", session)).json());
      expect(depot.items).toEqual([]);

      // El vehículo sin señal (detenido hace 3 horas, último mensaje hace 1 hora) NO aparece aunque cumpla el tiempo.
      const all = stoppedVehiclesResponseSchema.parse(await (await get("/v1/vehicles/stopped?minMinutes=1", session)).json());
      expect(all.items.map((item) => item.vehicleId)).toEqual([vehicle.id]);

      // La alerta que levantó el processor está en /v1/alerts, con la placa y el nombre de la zona de un JOIN.
      const alerts = await waitFor("la alerta critical_zone_stop en /v1/alerts (tenant Norte)", async () => {
        const body = alertsResponseSchema.parse(await (await get("/v1/alerts", session)).json());
        return body.items.length > 0 ? body : undefined;
      });
      expect(alerts.items).toHaveLength(1);
      expect(alerts.items[0]).toMatchObject({ vehicleId: vehicle.id, plate: vehicle.plate, type: "critical_zone_stop", zoneId: norte.zoneId, zoneName: norte.zoneName, resolvedAt: null });
      expect(alerts.nextCursor).toBeNull();

      // El otro tenant no ve nada de esto.
      const sureSession = await sessionOf(sur);
      const surStopped = stoppedVehiclesResponseSchema.parse(await (await get("/v1/vehicles/stopped?minMinutes=20&zoneKind=critical", sureSession)).json());
      expect(surStopped.items.map((item) => item.vehicleId)).toEqual([vehicleOf(sur, "stopped").id]);
    },
    120_000,
  );
});

describe("aislamiento entre tenants", () => {
  it("el usuario de Norte ve solo datos de Norte en summary, stopped, alerts y zones", async () => {
    const session = await sessionOf(norte);
    const norteIds = Object.values(norte.vehicles).map((vehicle) => vehicle.id);
    const surIds = Object.values(sur.vehicles).map((vehicle) => vehicle.id);

    const summary = fleetSummarySchema.parse(await (await get("/v1/summary", session)).json());
    // 4 vehículos: sin estado todavía (pairing) y detenido sin señal (stale) cuentan sin señal; b1 detenido; moving en movimiento.
    expect(summary.vehicles).toEqual({ total: 4, moving: 1, stopped: 1, noSignal: 2 });
    expect(summary.activeAlerts).toBe(1);

    const stopped = stoppedVehiclesResponseSchema.parse(await (await get("/v1/vehicles/stopped?minMinutes=1&limit=200", session)).json());
    expect(stopped.items.every((item) => norteIds.includes(item.vehicleId))).toBe(true);

    const alerts = alertsResponseSchema.parse(await (await get("/v1/alerts?status=all&limit=200", session)).json());
    expect(alerts.items.every((alert) => norteIds.includes(alert.vehicleId))).toBe(true);

    const zones = zoneFeatureCollectionSchema.parse(await (await get("/v1/zones/geojson", session)).json());
    expect(zones.features.map((feature) => feature.properties)).toEqual([{ zoneId: norte.zoneId, name: norte.zoneName, kind: "critical" }]);
    // Regla 13: [lng, lat]. El primer vértice de la zona sembrada es (-75.57, 6.25).
    expect(zones.features[0]?.geometry.coordinates[0]?.[0]).toEqual([-75.57, 6.25]);

    const everything = JSON.stringify([summary, stopped, alerts, zones]);
    for (const foreign of [...surIds, sur.zoneId, sur.zoneName, sur.tenantId]) expect(everything).not.toContain(foreign);
  });

  it("el usuario de Sur ve solo lo suyo y nada de Norte", async () => {
    const session = await sessionOf(sur);
    const norteIds = Object.values(norte.vehicles).map((vehicle) => vehicle.id);

    const summary = fleetSummarySchema.parse(await (await get("/v1/summary", session)).json());
    expect(summary.vehicles).toEqual({ total: 1, moving: 0, stopped: 1, noSignal: 0 });
    expect(summary.activeAlerts).toBe(1);

    const stopped = stoppedVehiclesResponseSchema.parse(await (await get("/v1/vehicles/stopped?minMinutes=1&limit=200", session)).json());
    expect(stopped.items.map((item) => item.vehicleId)).toEqual([vehicleOf(sur, "stopped").id]);
    expect(stopped.items[0]?.zone).toMatchObject({ zoneId: sur.zoneId, kind: "critical" });
    const alerts = alertsResponseSchema.parse(await (await get("/v1/alerts?status=all&limit=200", session)).json());
    expect(alerts.items).toHaveLength(1);
    const zones = zoneFeatureCollectionSchema.parse(await (await get("/v1/zones/geojson", session)).json());
    expect(zones.features.map((feature) => feature.properties.zoneId)).toEqual([sur.zoneId]);

    const everything = JSON.stringify([summary, stopped, alerts, zones]);
    for (const foreign of [...norteIds, norte.zoneId, norte.zoneName, norte.tenantId, norte.email]) expect(everything).not.toContain(foreign);
  });

  it("el tenant NO se puede imponer desde la petición: ?tenantId= y x-tenant-id se ignoran", async () => {
    const session = await sessionOf(sur);

    const response = await fetch(`${fleetApiUrl}/v1/summary?tenantId=${norte.tenantId}`, { headers: { cookie: session.cookie, "x-tenant-id": norte.tenantId } });

    expect(fleetSummarySchema.parse(await response.json()).vehicles.total).toBe(1);
  });

  it("la paginación de alertas por cursor es del propio tenant y recorre todo sin repetir", async () => {
    const extra = await Promise.all([seedAlert(sur, vehicleOf(sur, "stopped").id, null), seedAlert(sur, vehicleOf(sur, "stopped").id, null)]);
    const session = await sessionOf(sur);

    const first = alertsResponseSchema.parse(await (await get("/v1/alerts?status=all&limit=2", session)).json());
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = alertsResponseSchema.parse(await (await get(`/v1/alerts?status=all&limit=2&cursor=${first.nextCursor ?? ""}`, session)).json());

    const seen = [...first.items, ...second.items].map((alert) => alert.alertId);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(3);
    for (const id of extra) expect(seen).toContain(id);
    expect(second.nextCursor).toBeNull();

    const invalid = await get("/v1/alerts?cursor=no-es-un-cursor", session);
    expect(invalid.status).toBe(400);
    expect(apiErrorSchema.parse(await invalid.json()).error.code).toBe("invalid_cursor");
  });
});

describe("vinculación de dispositivos de punta a punta", () => {
  const point = (vehicleId: string) => ({
    eventId: randomUUID(),
    vehicleId,
    recordedAt: minutesAgo(2).toISOString(),
    ...INSIDE_A,
    speedMps: 5,
    headingDeg: 45,
    accuracyM: 6,
    mocked: false,
    lowAccuracy: false,
  });

  const createCode = (session: Session | undefined, vehicleId: string) =>
    fetch(`${fleetApiUrl}/v1/devices/pairing-codes`, { method: "POST", headers: { ...json, ...(session !== undefined && { cookie: session.cookie }) }, body: JSON.stringify({ vehicleId }) });

  const pair = (code: string, ip = nextIp()) => fetch(`${fleetApiUrl}/v1/devices/pair`, { method: "POST", headers: { ...json, "x-forwarded-for": ip }, body: JSON.stringify({ code }) });

  it("el usuario crea un código, el dispositivo lo canjea y el token da 202 en el gateway; el mismo código usado otra vez falla", async () => {
    const vehicle = vehicleOf(norte, "pairing");
    const session = await sessionOf(norte);

    const created = await createCode(session, vehicle.id);
    expect(created.status).toBe(201);
    const code = pairingCodeSchema.parse(await created.json());
    expect(code.vehicleId).toBe(vehicle.id);
    expect(code.code).toHaveLength(PAIRING_CODE_LENGTH);
    expect([...code.code].every((char) => PAIRING_CODE_ALPHABET.includes(char))).toBe(true);
    expect(new Date(code.expiresAt).getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);

    // El "dispositivo" (el móvil) canjea SIN sesión.
    const paired = await pair(code.code);
    expect(paired.status).toBe(201);
    const device = devicePairResponseSchema.parse(await paired.json());
    expect(device).toMatchObject({ vehicleId: vehicle.id, plate: vehicle.plate });

    // El token vale en el gateway.
    const accepted = await fetch(`${gatewayUrl}/v1/telemetry/batches`, {
      method: "POST",
      headers: { ...json, authorization: `Bearer ${device.deviceToken}` },
      body: JSON.stringify({ schemaVersion: 1, sentAt: new Date().toISOString(), points: [point(vehicle.id)] }),
    });
    expect(accepted.status).toBe(202);
    expect(batchAckSchema.parse(await accepted.json()).rejected).toEqual([]);

    // El mismo código otra vez: 404 genérico, y no crea otro dispositivo.
    const again = await pair(code.code);
    expect(again.status).toBe(404);
    expect(apiErrorSchema.parse(await again.json()).error.code).toBe("invalid_pairing_code");
    const active = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM devices WHERE vehicle_id = $1 AND revoked_at IS NULL", [vehicle.id]);
    expect(active.rows[0]?.n).toBe(1);
    // En la base solo está el hash del código y del token.
    const stored = JSON.stringify([
      (await db.query("SELECT * FROM device_pairing_codes WHERE vehicle_id = $1", [vehicle.id])).rows,
      (await db.query("SELECT * FROM devices WHERE vehicle_id = $1", [vehicle.id])).rows,
    ]);
    expect(stored).not.toContain(code.code);
    expect(stored).not.toContain(device.deviceToken);
    expect(stored).toContain(sha256Hex(device.deviceToken));
  });

  it("volver a vincular el vehículo revoca el dispositivo anterior: queda UNO solo activo", async () => {
    const vehicle = vehicleOf(norte, "pairing");
    const session = await sessionOf(norte);
    const code = pairingCodeSchema.parse(await (await createCode(session, vehicle.id)).json());

    const paired = devicePairResponseSchema.parse(await (await pair(code.code)).json());

    const { rows } = await db.query<{ token_hash: string }>("SELECT token_hash FROM devices WHERE vehicle_id = $1 AND revoked_at IS NULL", [vehicle.id]);
    expect(rows.map((row) => row.token_hash)).toEqual([sha256Hex(paired.deviceToken)]);
  });

  it("crear un código exige sesión, y un vehículo de otro tenant es 404 (igual que uno inexistente)", async () => {
    const session = await sessionOf(sur);

    expect((await createCode(undefined, vehicleOf(norte, "pairing").id)).status).toBe(401);
    const foreign = await createCode(session, vehicleOf(norte, "pairing").id);
    const unknown = await createCode(session, randomUUID());

    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await foreign.json()).toEqual(await unknown.json());
  });

  it("un código inexistente o vencido da el mismo 404 que uno usado, y tras N fallos desde una IP el canje responde 429", async () => {
    const vehicle = vehicleOf(norte, "pairing");
    const session = await sessionOf(norte);
    const expired = pairingCodeSchema.parse(await (await createCode(session, vehicle.id)).json());
    await db.query("UPDATE device_pairing_codes SET expires_at = now() - interval '1 second' WHERE code_hash = $1", [sha256Hex(expired.code)]);
    const randomCode = () => Array.from({ length: PAIRING_CODE_LENGTH }, () => PAIRING_CODE_ALPHABET.charAt(randomInt(PAIRING_CODE_ALPHABET.length))).join("");
    const attacker = nextIp();

    const expiredResponse = await pair(expired.code, attacker);
    expect(expiredResponse.status).toBe(404);
    const expiredBody = await expiredResponse.json();
    for (let i = 1; i < E2E_PAIR_FAILURE_LIMIT_MAX; i++) {
      const response = await pair(randomCode(), attacker);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual(expiredBody);
    }
    const blocked = await pair(randomCode(), attacker);

    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    // Otra IP sigue pudiendo canjear códigos.
    const fresh = pairingCodeSchema.parse(await (await createCode(session, vehicle.id)).json());
    expect((await pair(fresh.code, nextIp())).status).toBe(201);
  });

  it("un código con formato inválido responde 400", async () => {
    for (const code of ["corto", "k7m2qx9p", "K7M2QX9O"]) expect((await pair(code)).status).toBe(400);
  });
});
