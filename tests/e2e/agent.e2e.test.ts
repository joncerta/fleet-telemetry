import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  agentHealthResponseSchema,
  apiErrorSchema,
  batchAckSchema,
  chatResponseSchema,
  DEVICE_TOKEN_PREFIX,
  deviceTokenSchema,
  sessionSchema,
  stoppedVehiclesResponseSchema,
  type ChatResponse,
} from "@fleet/contracts";
import { hashPassword, loadConfig, sha256Hex } from "@fleet/platform";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import "./provided-context.js";
import { controlService } from "./service-control.js";
import { e2eConfigSchema } from "./support.js";

// Flujo e2e del agente (agent, fleet-api, ingest-gateway y processor los levantó el arnés desde dist/; el agente con el modelo con guion,
// sin API key): login por cookie -> POST /v1/chat -> createAgent -> herramienta get_stopped_vehicles -> cliente resiliente -> fleet-api ->
// base. Un vehículo detenido más de 20 minutos en zona crítica entra por el gateway (gateway -> Kafka -> processor -> base), así que el
// chat recorre todo el camino. Los datos (tenants, usuarios, vehículos, zonas) son de esta corrida y se borran al terminar.
const fleetApiUrl = inject("fleetApiUrl");
const gatewayUrl = inject("gatewayUrl");
const agentUrl = inject("agentUrl");
const runId = inject("runId");
const logDir = inject("serviceLogDir");
const config = loadConfig(e2eConfigSchema);

const db = new Client({ connectionString: config.DATABASE_ADMIN_URL });

// Parámetros baratos de scrypt: el login verifica con los que trae el hash.
const CHEAP_SCRYPT = { N: 1_024, r: 8, p: 1 } as const;

const B1_QUESTION = "¿Qué vehículos llevan detenidos más de 20 minutos en zonas críticas?";

// Rectángulo de ~1 km en Medellín: la zona CRÍTICA de Norte. Y uno en Bogotá: la de Sur. Longitud primero.
const ZONE_NORTE = "POLYGON((-75.57 6.25, -75.56 6.25, -75.56 6.26, -75.57 6.26, -75.57 6.25))";
const INSIDE_NORTE = { lon: -75.565, lat: 6.255 };
const ZONE_SUR = "POLYGON((-74.075 4.705, -74.065 4.705, -74.065 4.715, -74.075 4.715, -74.075 4.705))";
const INSIDE_SUR = { lon: -74.07, lat: 4.71 };

interface Tenant {
  label: string;
  tenantId: string;
  email: string;
  password: string;
  zoneId: string;
  zoneName: string;
  vehicles: Record<string, { id: string; plate: string }>;
}

const tenantIds: string[] = [];
const RUN_START_MS = Date.now();
const minutesAgo = (minutes: number) => new Date(RUN_START_MS - minutes * 60_000);

/** Una IP de documentación distinta por llamada: ningún límite por IP se comparte entre tests. */
let ipCounter = 100;
const nextIp = () => `192.0.2.${ipCounter++}`;

async function createTenant(label: string, zoneWkt: string, roles: string[]): Promise<Tenant> {
  const tenantId = randomUUID();
  const zoneId = randomUUID();
  const password = randomBytes(18).toString("base64url");
  const email = `e2e-agent-${runId}-${label}@flota.test`;
  const zoneName = `Zona crítica ${label} ${runId}`;
  await db.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [tenantId, `e2e-agent-${runId}-${label}`]);
  tenantIds.push(tenantId);
  await db.query("INSERT INTO users (user_id, tenant_id, email, name, password_hash) VALUES ($1, $2, $3, $4, $5)", [
    randomUUID(),
    tenantId,
    email,
    `Operador ${label}`,
    await hashPassword(password, CHEAP_SCRYPT),
  ]);
  await db.query("INSERT INTO zones (zone_id, tenant_id, name, kind, geom) VALUES ($1, $2, $3, 'critical', ST_GeomFromText($4, 4326))", [zoneId, tenantId, zoneName, zoneWkt]);
  const vehicles: Tenant["vehicles"] = {};
  for (const role of roles) {
    const id = randomUUID();
    const plate = `A${id.slice(0, 5).toUpperCase()}`;
    await db.query("INSERT INTO vehicles (id, tenant_id, plate) VALUES ($1, $2, $3)", [id, tenantId, plate]);
    vehicles[role] = { id, plate };
  }
  return { label, tenantId, email, password, zoneId, zoneName, vehicles };
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

/** El estado de un vehículo directo en la base (el de Sur: lo que importa de él es que sea de OTRO tenant). */
async function seedStoppedState(tenant: Tenant, vehicleId: string, at: { lon: number; lat: number }): Promise<void> {
  await db.query(
    `INSERT INTO vehicle_state (vehicle_id, tenant_id, geom, recorded_at, received_at, speed_mps, heading_deg, movement, stopped_since, zone_ids, mocked, low_accuracy)
     VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326), $5, $5, 0, NULL, 'stopped', $6, $7::uuid[], false, false)`,
    [vehicleId, tenant.tenantId, at.lon, at.lat, minutesAgo(1), minutesAgo(60), [tenant.zoneId]],
  );
}

let norte: Tenant;
let sur: Tenant;

beforeAll(async () => {
  await db.connect();
  norte = await createTenant("norte", ZONE_NORTE, ["b1"]);
  sur = await createTenant("sur", ZONE_SUR, ["stopped"]);
  await seedStoppedState(sur, vehicleOf(sur, "stopped").id, INSIDE_SUR);
});

afterAll(async () => {
  // Limpieza de los datos de esta corrida, en el orden de las claves foráneas.
  if (tenantIds.length > 0) {
    const by = (table: string, column = "tenant_id") => db.query(`DELETE FROM ${table} WHERE ${column} = ANY($1::uuid[])`, [tenantIds]).catch(() => undefined);
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
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const json = { "content-type": "application/json" };

/** Inicia sesión en fleet-api (el flujo real de la web) y devuelve la cookie lista para el header `cookie`. */
async function loginCookie(tenant: Tenant): Promise<string> {
  const response = await fetch(`${fleetApiUrl}/v1/auth/login`, {
    method: "POST",
    headers: { ...json, "x-forwarded-for": nextIp() },
    body: JSON.stringify({ email: tenant.email, password: tenant.password }),
  });
  expect(response.status).toBe(200);
  expect(sessionSchema.parse(await response.json()).tenant.tenantId).toBe(tenant.tenantId);
  const setCookie = response.headers.getSetCookie().find((cookie) => cookie.startsWith("fleet_session="));
  if (setCookie === undefined) throw new Error("el login no dejó la cookie");
  return setCookie.split(";", 1)[0] ?? "";
}

async function chat(cookie: string | undefined, message: string, extra: Record<string, unknown> = {}): Promise<{ response: Response; body: unknown }> {
  const response = await fetch(`${agentUrl}/v1/chat`, {
    method: "POST",
    headers: { ...json, "x-forwarded-for": nextIp(), "x-correlation-id": `e2e-agent-${runId}`, ...(cookie !== undefined && { cookie }) },
    body: JSON.stringify({ message, ...extra }),
  });
  return { response, body: await response.json() };
}

async function chatOk(cookie: string, message: string): Promise<ChatResponse> {
  const { response, body } = await chat(cookie, message);
  expect(response.status).toBe(200);
  return chatResponseSchema.parse(body);
}

describe("POST /v1/chat: la pregunta B1 de punta a punta", () => {
  it(
    "con la sesión de Norte, la pregunta de los vehículos detenidos en zonas críticas llama a get_stopped_vehicles (ok) y responde con el vehículo real",
    async () => {
      const vehicle = vehicleOf(norte, "b1");
      const token = await createDevice(norte, vehicle.id);
      const point = (ago: number, speedMps: number) => ({
        eventId: randomUUID(),
        vehicleId: vehicle.id,
        recordedAt: minutesAgo(ago).toISOString(),
        ...INSIDE_NORTE,
        speedMps,
        headingDeg: 90,
        accuracyM: 6,
        mocked: false,
        lowAccuracy: false,
      });
      // Un punto en movimiento y seis detenidos dentro de la zona crítica, de hace 70 a hace 45 minutos (25 min detenido), fechados hacia atrás.
      const points = [point(80, 9), ...[70, 65, 60, 55, 50, 45].map((ago) => point(ago, 0))];
      const ingest = await fetch(`${gatewayUrl}/v1/telemetry/batches`, {
        method: "POST",
        headers: { ...json, authorization: `Bearer ${token}`, "x-correlation-id": `e2e-agent-${runId}-b1` },
        body: JSON.stringify({ schemaVersion: 1, sentAt: new Date().toISOString(), points }),
      });
      expect(ingest.status).toBe(202);
      expect(batchAckSchema.parse(await ingest.json()).accepted).toEqual(points.map((p) => p.eventId));

      const cookie = await loginCookie(norte);
      const answered = await waitFor("el chat con el vehículo de Norte en la respuesta", async () => {
        const result = await chatOk(cookie, B1_QUESTION);
        return result.answer.includes(vehicle.plate) ? result : undefined;
      });

      expect(answered.toolCalls).toEqual([
        { name: "get_stopped_vehicles", input: { minMinutes: 20, zoneKind: "critical", limit: 20 }, status: "ok", durationMs: expect.any(Number) as number },
      ]);
      expect(answered.answer).toContain(vehicle.plate);
      expect(answered.answer).toContain(norte.zoneName);
      expect(answered.breaker).toEqual({ state: "closed" });
      // El `input` de la herramienta es solo lo que el LLM envió: nada de la sesión.
      expect(JSON.stringify(answered)).not.toMatch(new RegExp(`${norte.tenantId}|fleet_session`));

      // Lo que dice el agente coincide con lo que dice fleet-api para esa misma sesión.
      const direct = stoppedVehiclesResponseSchema.parse(await (await fetch(`${fleetApiUrl}/v1/vehicles/stopped?minMinutes=20&zoneKind=critical`, { headers: { cookie } })).json());
      expect(direct.items.map((item) => item.plate)).toEqual([vehicle.plate]);
    },
    120_000,
  );

  it("el correlationId de la petición llega a fleet-api: el log de fleet-api lo registra", async () => {
    const cookie = await loginCookie(norte);

    await chatOk(cookie, B1_QUESTION);

    const log = readFileSync(join(logDir, "fleet-api.log"), "utf8");
    expect(log).toContain(`e2e-agent-${runId}`);
  });
});

describe("POST /v1/chat: aislamiento entre tenants y sesión", () => {
  it("el usuario de Sur, con la misma pregunta, ve solo lo suyo y nada de Norte", async () => {
    const cookie = await loginCookie(sur);

    const result = await chatOk(cookie, B1_QUESTION);

    const surVehicle = vehicleOf(sur, "stopped");
    const norteVehicle = vehicleOf(norte, "b1");
    expect(result.toolCalls[0]).toMatchObject({ name: "get_stopped_vehicles", status: "ok" });
    expect(result.answer).toContain(surVehicle.plate);
    expect(result.answer).toContain(sur.zoneName);
    const everything = JSON.stringify(result);
    for (const foreign of [norteVehicle.plate, norteVehicle.id, norte.zoneName, norte.zoneId, norte.tenantId]) expect(everything).not.toContain(foreign);
  });

  it("el tenant no se puede imponer desde el cuerpo: un tenantId en la petición se descarta y se usa el de la sesión", async () => {
    const cookie = await loginCookie(sur);

    const { response, body } = await chat(cookie, B1_QUESTION, { tenantId: norte.tenantId, userId: randomUUID() });

    expect(response.status).toBe(200);
    const result = chatResponseSchema.parse(body);
    expect(result.answer).toContain(vehicleOf(sur, "stopped").plate);
    expect(result.answer).not.toContain(vehicleOf(norte, "b1").plate);
  });

  it("sin cookie, con una cookie inválida o con un cuerpo inválido sin sesión, responde 401", async () => {
    for (const cookie of [undefined, "fleet_session=basura"]) {
      const { response, body } = await chat(cookie, B1_QUESTION);

      expect(response.status).toBe(401);
      expect(apiErrorSchema.parse(body).error.code).toBe("unauthorized");
    }
    const noBody = await fetch(`${agentUrl}/v1/chat`, { method: "POST", headers: { ...json, "x-forwarded-for": nextIp() }, body: JSON.stringify({}) });
    expect(noBody.status).toBe(401);
  });

  it("con sesión válida, un cuerpo inválido responde 400", async () => {
    const cookie = await loginCookie(norte);

    expect((await chat(cookie, "")).response.status).toBe(400);
    expect((await chat(cookie, "a".repeat(2_001))).response.status).toBe(400);
  });

  it("una pregunta fuera de tema no llama herramientas", async () => {
    const result = await chatOk(await loginCookie(norte), "cuéntame un chiste");

    expect(result.toolCalls).toEqual([]);
    expect(result.answer).toMatch(/solo puedo responder/i);
  });

  it("CORS: el origen de la web recibe Allow-Credentials en el preflight de POST /v1/chat; otro origen no", async () => {
    const preflight = (origin: string) =>
      fetch(`${agentUrl}/v1/chat`, {
        method: "OPTIONS",
        headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
      });

    const allowed = await preflight("http://localhost:3000");
    const denied = await preflight("http://evil.test");

    expect(allowed.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(allowed.headers.get("access-control-allow-credentials")).toBe("true");
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("GET /health responde 200 con el breaker cerrado y GET /health/live responde 200", async () => {
    const health = await fetch(`${agentUrl}/health`);

    expect(health.status).toBe(200);
    expect(agentHealthResponseSchema.parse(await health.json())).toEqual({
      status: "ok",
      checks: { fleetApi: "up", model: "up" },
      dependencies: { fleetApi: { breaker: "closed" }, model: { breaker: "closed" } },
    });
    const live = await fetch(`${agentUrl}/health/live`);
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: "ok" });
  });
});

// Último: para fleet-api y lo vuelve a levantar. El breaker del agente es de proceso: las llamadas de los tests anteriores no cuentan para él.
describe("circuit breaker hacia fleet-api", () => {
  afterAll(async () => {
    // Si el test falló con fleet-api parado, los demás flujos e2e lo necesitan: se vuelve a levantar sin falta (si ya está arriba, no hace nada).
    await controlService("fleet-api", "start").catch(() => undefined);
  });

  it(
    "con fleet-api detenido el chat dice que no hay datos disponibles, sin inventar vehículos; breaker open, /health lo refleja; al volver fleet-api el breaker se cierra",
    async () => {
      const cookie = await loginCookie(norte);
      const norteVehicle = vehicleOf(norte, "b1");
      expect((await chatOk(cookie, B1_QUESTION)).answer).toContain(norteVehicle.plate);

      await controlService("fleet-api", "stop");

      // Las primeras llamadas fallan contra fleet-api caído (upstream_error); al llegar al umbral el circuito se abre y el resto ni sale.
      const open = await waitFor("el breaker en open", async () => {
        const result = await chatOk(cookie, B1_QUESTION);
        return result.breaker.state === "open" ? result : undefined;
      });

      expect(open.toolCalls).toEqual([expect.objectContaining({ name: "get_stopped_vehicles", status: "error" })]);
      expect(open.answer).toMatch(/no hay datos disponibles/i);
      // No inventa: ni la placa de Norte ni ninguna otra, ni la zona.
      expect(open.answer).not.toContain(norteVehicle.plate);
      expect(open.answer).not.toContain(norte.zoneName);
      expect(open.answer).not.toMatch(/\bA[0-9A-F]{5}\b/);

      const health = await fetch(`${agentUrl}/health`);
      expect(health.status).toBe(503);
      expect(agentHealthResponseSchema.parse(await health.json())).toEqual({
        status: "degraded",
        checks: { fleetApi: "down", model: "up" },
        dependencies: { fleetApi: { breaker: "open" }, model: { breaker: "closed" } },
      });
      // El agente sigue vivo aunque fleet-api no esté.
      expect((await fetch(`${agentUrl}/health/live`)).status).toBe(200);

      // Se vuelve a levantar fleet-api: tras el reset del breaker, la siguiente pregunta lo prueba y lo cierra, con datos reales otra vez.
      await controlService("fleet-api", "start");
      const recovered = await waitFor("el breaker cerrado y el vehículo de nuevo en la respuesta", async () => {
        const result = await chatOk(cookie, B1_QUESTION);
        return result.breaker.state === "closed" && result.answer.includes(norteVehicle.plate) ? result : undefined;
      });

      expect(recovered.toolCalls[0]).toMatchObject({ name: "get_stopped_vehicles", status: "ok" });
      expect((await fetch(`${agentUrl}/health`)).status).toBe(200);
    },
    120_000,
  );
});
