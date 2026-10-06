import { randomBytes, randomUUID } from "node:crypto";
import {
  apiErrorSchema,
  batchAckSchema,
  DEVICE_TOKEN_PREFIX,
  deviceTokenSchema,
  SSE_HEARTBEAT_COMMENT,
  sseAlertSchema,
  sseSnapshotSchema,
  sseVehicleStateSchema,
  type SseAlert,
  type SseSnapshot,
  type SseVehicleState,
} from "@fleet/contracts";
import { hashPassword, loadConfig, sha256Hex } from "@fleet/platform";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { E2E_SSE_HEARTBEAT_MS, E2E_SSE_MAX_STREAMS_PER_USER } from "./harness.js";
import "./provided-context.js";
import { openSse, type SseBlock, type SseConnection } from "./sse-client.js";
import { e2eConfigSchema } from "./support.js";

// Flujo e2e del stream SSE de la flota: login (cookie) -> GET /v1/stream -> snapshot primero con id -> latidos -> un lote por el gateway que detiene
// un vehículo 25 minutos en zona crítica -> ingest-gateway -> Kafka -> processor -> base -> vehicle.state y fleet.alerts -> consumer del SSE de
// fleet-api -> eventos `vehicle.state` y `alert` con seq mayor que el cursor del snapshot. Y el AISLAMIENTO: el stream de un tenant no recibe nada
// del otro. Gateway, processor y fleet-api los levantó el arnés desde dist/ (latido de 1 s y 3 streams por usuario). Los datos son de esta corrida.
const fleetApiUrl = inject("fleetApiUrl");
const gatewayUrl = inject("gatewayUrl");
const runId = inject("runId");
const config = loadConfig(e2eConfigSchema);
const STREAM_URL = `${fleetApiUrl}/v1/stream`;
const ALLOWED_ORIGIN = "http://localhost:3000";

const db = new Client({ connectionString: config.DATABASE_ADMIN_URL });
const CHEAP_SCRYPT = { N: 1_024, r: 8, p: 1 } as const;

// Zona CRÍTICA de Norte (Medellín) y un punto dentro (longitud primero); la de Sur es otra, en Bogotá.
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
  vehicleId: string;
  plate: string;
  deviceToken: string;
}

const tenantIds: string[] = [];
const RUN_START_MS = Date.now();
const minutesAgo = (minutes: number) => new Date(RUN_START_MS - minutes * 60_000).toISOString();
const rangeFrom = () => new Date(RUN_START_MS - 3 * 3_600_000);
const rangeTo = () => new Date(Date.now() + 3_600_000);

/** Una IP de documentación (192.0.2.0/24) distinta por llamada: ningún límite por IP se comparte entre tests. */
let ipCounter = 100;
const nextIp = () => `192.0.2.${ipCounter++}`;

async function createTenant(label: string, zoneWkt: string): Promise<Tenant> {
  const tenantId = randomUUID();
  const zoneId = randomUUID();
  const vehicleId = randomUUID();
  const password = randomBytes(18).toString("base64url");
  const email = `e2e-${runId}-sse-${label}@flota.test`;
  const plate = `S${vehicleId.slice(0, 5).toUpperCase()}`;
  const deviceToken = deviceTokenSchema.parse(`${DEVICE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`);
  await db.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [tenantId, `e2e-${runId}-sse-${label}`]);
  tenantIds.push(tenantId);
  await db.query("INSERT INTO users (user_id, tenant_id, email, name, password_hash) VALUES ($1, $2, $3, $4, $5)", [
    randomUUID(),
    tenantId,
    email,
    `Operador ${label}`,
    await hashPassword(password, CHEAP_SCRYPT),
  ]);
  await db.query("INSERT INTO zones (zone_id, tenant_id, name, kind, geom) VALUES ($1, $2, $3, 'critical', ST_GeomFromText($4, 4326))", [
    zoneId,
    tenantId,
    `Zona crítica sse ${label} ${runId}`,
    zoneWkt,
  ]);
  await db.query("INSERT INTO vehicles (id, tenant_id, plate) VALUES ($1, $2, $3)", [vehicleId, tenantId, plate]);
  await db.query("INSERT INTO devices (id, tenant_id, vehicle_id, token_hash) VALUES ($1, $2, $3, $4)", [randomUUID(), tenantId, vehicleId, sha256Hex(deviceToken)]);
  return { label, tenantId, email, password, zoneId, vehicleId, plate, deviceToken };
}

let norte: Tenant;
let sur: Tenant;
/** Un tenant aparte para el test del límite por usuario: los streams de los otros tests siguen abiertos y contarían contra el cupo. */
let limite: Tenant;

beforeAll(async () => {
  await db.connect();
  norte = await createTenant("norte", ZONE_NORTE);
  sur = await createTenant("sur", ZONE_SUR);
  limite = await createTenant("limite", ZONE_NORTE);
  // Sur ya tiene un estado y una alerta activa: su snapshot no está vacío y no debe aparecer en el de Norte.
  await db.query(
    `INSERT INTO vehicle_state (vehicle_id, tenant_id, geom, recorded_at, received_at, speed_mps, heading_deg, movement, stopped_since, zone_ids, mocked, low_accuracy)
     VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326), $5, $5, 0, NULL, 'stopped', $6, $7::uuid[], false, false)`,
    [sur.vehicleId, sur.tenantId, INSIDE_SUR.lon, INSIDE_SUR.lat, minutesAgo(5), minutesAgo(60), [sur.zoneId]],
  );
  await db.query("INSERT INTO alerts (alert_id, tenant_id, vehicle_id, type, zone_id, started_at, raised_at) VALUES ($1, $2, $3, 'critical_zone_stop', $4, $5, $6)", [
    randomUUID(),
    sur.tenantId,
    sur.vehicleId,
    sur.zoneId,
    minutesAgo(40),
    minutesAgo(20),
  ]);
});

const opened: SseConnection[] = [];

afterAll(async () => {
  for (const connection of opened) connection.close();
  if (tenantIds.length > 0) {
    await db.query("DELETE FROM alerts WHERE tenant_id = ANY($1::uuid[])", [tenantIds]).catch(() => undefined);
    await db.query("DELETE FROM vehicle_state WHERE tenant_id = ANY($1::uuid[])", [tenantIds]).catch(() => undefined);
    await db.query("DELETE FROM zones WHERE tenant_id = ANY($1::uuid[])", [tenantIds]).catch(() => undefined);
    await db.query("DELETE FROM telemetry WHERE tenant_id = ANY($1::uuid[]) AND recorded_at >= $2 AND recorded_at < $3", [tenantIds, rangeFrom(), rangeTo()]).catch(() => undefined);
    await db.query("DELETE FROM devices WHERE tenant_id = ANY($1::uuid[])", [tenantIds]).catch(() => undefined);
    await db.query("DELETE FROM users WHERE tenant_id = ANY($1::uuid[])", [tenantIds]).catch(() => undefined);
    await db.query("DELETE FROM vehicles WHERE tenant_id = ANY($1::uuid[])", [tenantIds]).catch(() => undefined);
    await db.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [tenantIds]).catch(() => undefined);
  }
  await db.end().catch(() => undefined);
});

/** Login real: devuelve el par `fleet_session=<token>` para el header `cookie`. */
async function login(tenant: Tenant): Promise<string> {
  const response = await fetch(`${fleetApiUrl}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": nextIp() },
    body: JSON.stringify({ email: tenant.email, password: tenant.password }),
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith("fleet_session="));
  if (cookie === undefined) throw new Error("El login no devolvió la cookie fleet_session");
  return cookie.split(";", 1)[0] ?? "";
}

async function openStream(cookie: string, extra: Record<string, string> = {}): Promise<SseConnection> {
  const connection = await openSse(STREAM_URL, { cookie, ...extra });
  opened.push(connection);
  return connection;
}

const dataOf = (block: SseBlock): unknown => JSON.parse(block.data ?? "null");

async function snapshotOf(connection: SseConnection): Promise<{ block: SseBlock; snapshot: SseSnapshot }> {
  const block = await connection.next();
  expect(block.event).toBe("snapshot");
  return { block, snapshot: sseSnapshotSchema.parse(dataOf(block)) };
}

const pointOf = (tenant: Tenant, at: { lon: number; lat: number }, recordedAt: string, speedMps: number) => ({
  eventId: randomUUID(),
  vehicleId: tenant.vehicleId,
  recordedAt,
  lon: at.lon,
  lat: at.lat,
  speedMps,
  headingDeg: 90,
  accuracyM: 6,
  mocked: false,
  lowAccuracy: false,
});

async function postBatch(tenant: Tenant, points: ReturnType<typeof pointOf>[], correlationId: string): Promise<void> {
  const response = await fetch(`${gatewayUrl}/v1/telemetry/batches`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${tenant.deviceToken}`, "x-correlation-id": correlationId },
    body: JSON.stringify({ schemaVersion: 1, sentAt: new Date().toISOString(), points }),
  });
  expect(response.status).toBe(202);
  const ack = batchAckSchema.parse(await response.json());
  expect(ack.accepted).toEqual(points.map((point) => point.eventId));
  expect(ack.rejected).toEqual([]);
}

const isEvent = (name: string) => (block: SseBlock) => block.event === name;

describe("GET /v1/stream contra el stack real", () => {
  it(
    "login -> snapshot primero con id -> latidos -> un vehículo detenido 25 min en zona crítica llega como vehicle.state y alert con seq mayor; el stream de Sur no recibe nada de Norte",
    async () => {
      const norteCookie = await login(norte);
      const surCookie = await login(sur);

      // --- Snapshot primero, con id = cursor, y cabeceras del stream (también CORS para el origen permitido).
      const norteStream = await openStream(norteCookie, { origin: ALLOWED_ORIGIN, "x-correlation-id": `e2e-${runId}-sse-open` });
      expect(norteStream.response.status).toBe(200);
      expect(norteStream.response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
      expect(norteStream.response.headers.get("cache-control")).toBe("no-cache");
      expect(norteStream.response.headers.get("x-accel-buffering")).toBe("no");
      expect(norteStream.response.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
      expect(norteStream.response.headers.get("access-control-allow-credentials")).toBe("true");
      expect(norteStream.response.headers.get("x-correlation-id")).toBe(`e2e-${runId}-sse-open`);

      const { block: norteSnapshotBlock, snapshot: norteSnapshot } = await snapshotOf(norteStream);
      expect(norteSnapshotBlock.id).toBe(norteSnapshot.cursor);
      // El primer frame lleva `retry:` (base 3000 ms + jitter de 0 a 5000 ms por defecto): evita la estampida de reconexiones tras un reinicio.
      expect(norteSnapshotBlock.retry).toBeGreaterThanOrEqual(3_000);
      expect(norteSnapshotBlock.retry).toBeLessThan(8_000);
      // Norte no tiene estado ni alertas todavía; nada de Sur en su snapshot.
      expect(norteSnapshot.vehicles.filter((vehicle) => vehicle.vehicleId === norte.vehicleId)).toEqual([]);
      expect(JSON.stringify(norteSnapshot)).not.toContain(sur.vehicleId);
      expect(JSON.stringify(norteSnapshot)).not.toContain(sur.plate);

      const surStream = await openStream(surCookie);
      const { block: surSnapshotBlock, snapshot: surSnapshot } = await snapshotOf(surStream);
      expect(surSnapshotBlock.id).toBe(surSnapshot.cursor);
      expect(surSnapshot.vehicles.map((vehicle) => vehicle.vehicleId)).toEqual([sur.vehicleId]);
      expect(surSnapshot.vehicles[0]).toMatchObject({ plate: sur.plate, movement: "stopped" });
      expect(surSnapshot.alerts).toHaveLength(1);
      expect(surSnapshot.alerts[0]).toMatchObject({ vehicleId: sur.vehicleId, plate: sur.plate, zoneId: sur.zoneId, resolvedAt: null });
      expect(JSON.stringify(surSnapshot)).not.toContain(norte.vehicleId);

      // --- Latido dentro del intervalo (1 s en el e2e): un comentario, sin id ni data.
      const beat = await norteStream.readUntil("un latido", (block) => block.comment === SSE_HEARTBEAT_COMMENT, E2E_SSE_HEARTBEAT_MS * 5);
      expect(beat).toEqual({ id: undefined, event: undefined, data: undefined, comment: SSE_HEARTBEAT_COMMENT });

      // --- Lote de Norte: un punto en movimiento y seis detenidos dentro de la zona crítica, de hace 70 a 45 min (25 min detenido).
      await postBatch(
        norte,
        [pointOf(norte, INSIDE_NORTE, minutesAgo(80), 9), ...[70, 65, 60, 55, 50, 45].map((ago) => pointOf(norte, INSIDE_NORTE, minutesAgo(ago), 0))],
        `e2e-${runId}-sse-norte`,
      );

      const stateBlock = await norteStream.readUntil(
        "vehicle.state de Norte detenido",
        (block) => block.event === "vehicle.state" && sseVehicleStateSchema.parse(dataOf(block)).state.movement === "stopped",
      );
      const stateEvent: SseVehicleState = sseVehicleStateSchema.parse(dataOf(stateBlock));
      expect(stateBlock.id).toBe(stateEvent.state.seq);
      expect(stateEvent.state).toMatchObject({ vehicleId: norte.vehicleId, plate: norte.plate, movement: "stopped", zoneIds: [norte.zoneId] });
      expect(BigInt(stateEvent.state.seq)).toBeGreaterThan(BigInt(norteSnapshot.cursor));

      const alertBlock = await norteStream.readUntil("alert de Norte", isEvent("alert"));
      const alertEvent: SseAlert = sseAlertSchema.parse(dataOf(alertBlock));
      expect(alertBlock.id).toBe(alertEvent.alert.seq);
      expect(alertEvent.alert).toMatchObject({ vehicleId: norte.vehicleId, plate: norte.plate, type: "critical_zone_stop", zoneId: norte.zoneId, resolvedAt: null });
      expect(BigInt(alertEvent.alert.seq)).toBeGreaterThan(BigInt(norteSnapshot.cursor));

      // --- Aislamiento. Control positivo: Sur también recibe lo SUYO (un punto en movimiento más nuevo que su estado), y solo eso.
      await postBatch(sur, [pointOf(sur, INSIDE_SUR, minutesAgo(0.5), 11)], `e2e-${runId}-sse-sur`);
      const surState = await surStream.readUntil("vehicle.state de Sur", isEvent("vehicle.state"));
      expect(sseVehicleStateSchema.parse(dataOf(surState)).state).toMatchObject({ vehicleId: sur.vehicleId, plate: sur.plate, movement: "moving" });

      // Se deja pasar el tiempo de varios latidos en AMBOS streams (no un sleep: se leen los latidos) para dar a un posible evento ajeno la
      // oportunidad de llegar; luego se comprueba todo lo recibido.
      for (const stream of [norteStream, surStream]) {
        await stream.readUntil("tres latidos más", (() => {
          let seen = 0;
          return (block: SseBlock) => block.comment === SSE_HEARTBEAT_COMMENT && ++seen === 3;
        })(), E2E_SSE_HEARTBEAT_MS * 10);
      }
      const surText = JSON.stringify(surStream.received);
      expect(surText).not.toContain(norte.vehicleId);
      expect(surText).not.toContain(norte.plate);
      expect(surText).not.toContain(norte.tenantId);
      expect(surText).not.toContain(norte.zoneId);
      const norteText = JSON.stringify(norteStream.received);
      expect(norteText).not.toContain(sur.vehicleId);
      expect(norteText).not.toContain(sur.plate);
      expect(norteText).not.toContain(sur.zoneId);

      // --- Reconexión: siempre un snapshot NUEVO (Last-Event-ID se ignora) con el estado y la alerta ya persistidos y un cursor que los cubre.
      const reconnected = await openStream(norteCookie, { "last-event-id": "999999999999" });
      const { snapshot: second } = await snapshotOf(reconnected);
      expect(second.vehicles.find((vehicle) => vehicle.vehicleId === norte.vehicleId)).toMatchObject({ movement: "stopped" });
      expect(second.alerts.map((alert) => alert.alertId)).toContain(alertEvent.alert.alertId);
      expect(BigInt(second.cursor)).toBeGreaterThanOrEqual(BigInt(alertEvent.alert.seq));
    },
    120_000,
  );

  it("sin cookie, con una cookie inválida o con un token en la URL responde 401 con apiErrorSchema", async () => {
    for (const request of [fetch(STREAM_URL), fetch(STREAM_URL, { headers: { cookie: "fleet_session=basura" } }), fetch(`${STREAM_URL}?token=abc&access_token=abc`)]) {
      const response = await request;
      expect(response.status).toBe(401);
      expect(apiErrorSchema.parse(await response.json()).error.code).toBe("unauthorized");
    }
  });

  it("un origen no autorizado no recibe Access-Control-Allow-Origin ni credenciales", async () => {
    const cookie = await login(sur);

    const stream = await openStream(cookie, { origin: "https://evil.example" });

    expect(stream.response.status).toBe(200);
    expect(stream.response.headers.get("access-control-allow-origin")).toBeNull();
    expect(stream.response.headers.get("access-control-allow-credentials")).toBeNull();
    stream.close();
  });

  it("el stream que pasa el límite por usuario recibe 429 (con CORS y apiErrorSchema); al cerrar uno se libera el cupo", async () => {
    const cookie = await login(limite);
    const streams: SseConnection[] = [];
    for (let i = 0; i < E2E_SSE_MAX_STREAMS_PER_USER; i++) {
      const stream = await openStream(cookie);
      expect(stream.response.status).toBe(200);
      await stream.next();
      streams.push(stream);
    }

    const rejected = await fetch(STREAM_URL, { headers: { cookie, origin: ALLOWED_ORIGIN } });
    expect(rejected.status).toBe(429);
    expect(apiErrorSchema.parse(await rejected.json()).error.code).toBe("rate_limited");
    expect(rejected.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);

    streams[0]?.close();
    // El servidor se entera del cierre de forma asíncrona: se reintenta (por sondeo, con tope) hasta que el cupo se libera.
    const deadline = Date.now() + 10_000;
    let status = 0;
    while (status !== 200 && Date.now() < deadline) {
      const retry = await openSse(STREAM_URL, { cookie });
      opened.push(retry);
      status = retry.response.status;
      if (status !== 200) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(status).toBe(200);
    for (const stream of streams) stream.close();
  });
});
