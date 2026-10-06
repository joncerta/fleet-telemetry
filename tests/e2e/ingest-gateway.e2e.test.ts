import { randomBytes, randomUUID } from "node:crypto";
import { request } from "node:http";
import {
  apiErrorSchema,
  batchAckSchema,
  DEVICE_TOKEN_PREFIX,
  deviceTokenSchema,
  telemetryDlqMessageSchema,
  telemetryRawEventSchema,
  TOPICS,
  type BatchAck,
  type TelemetryDlqMessage,
  type TelemetryRawEvent,
} from "@fleet/contracts";
import { createAdmin, createConsumer, createKafka, createLogger, getCorrelationId, loadConfig, sha256Hex } from "@fleet/platform";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { E2E_AUTH_FAILURE_LIMIT_MAX } from "./harness.js";
import "./provided-context.js";
import { e2eConfigSchema } from "./support.js";

// Flujo e2e de la ingesta: HTTP (ingest-gateway levantado desde dist/ por el arnés) -> Kafka (telemetry.raw y
// telemetry.dlq). La persistencia la agrega el processor en el siguiente caso de uso: aquí se verifica lo que el gateway
// publica. Los datos (tenant, vehículo, dispositivo, puntos) son de esta corrida y se borran al terminar.
const gatewayUrl = inject("gatewayUrl");
const runId = inject("runId");
const config = loadConfig(e2eConfigSchema);
const BATCHES_URL = `${gatewayUrl}/v1/telemetry/batches`;

const kafka = createKafka({ brokers: config.KAFKA_BROKERS, clientId: `e2e-ingest-gateway-${runId}`, logger: createLogger({ service: "e2e-ingest-gateway", level: "error" }) });
const admin = createAdmin(kafka);
const consumerGroup = `e2e-ingest-gateway-${runId}`;
const consumer = createConsumer(kafka, { groupId: consumerGroup });
const db = new Client({ connectionString: config.DATABASE_ADMIN_URL });

interface SeenMessage {
  key: string | undefined;
  correlationId: string | undefined;
  value: unknown;
}
const rawSeen: SeenMessage[] = [];
const dlqSeen: SeenMessage[] = [];

interface Fleet {
  tenantId: string;
  vehicleId: string;
  deviceId: string;
  token: string;
}

const tenantIds: string[] = [];

/** Tenant, vehículo y dispositivo aislados por runId. Con `revoked` el dispositivo nace revocado. */
async function createFleet(label: string, options: { revoked?: boolean } = {}): Promise<Fleet> {
  const tenantId = randomUUID();
  const vehicleId = randomUUID();
  const deviceId = randomUUID();
  const token = deviceTokenSchema.parse(`${DEVICE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`);
  await db.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [tenantId, `e2e-${runId}-${label}`]);
  tenantIds.push(tenantId);
  await db.query("INSERT INTO vehicles (id, tenant_id, plate) VALUES ($1, $2, $3)", [vehicleId, tenantId, `E${vehicleId.slice(0, 5).toUpperCase()}`]);
  await db.query("INSERT INTO devices (id, tenant_id, vehicle_id, token_hash, revoked_at) VALUES ($1, $2, $3, $4, $5)", [
    deviceId,
    tenantId,
    vehicleId,
    sha256Hex(token),
    options.revoked === true ? new Date() : null,
  ]);
  return { tenantId, vehicleId, deviceId, token };
}

beforeAll(async () => {
  await db.connect();
  await admin.connect();
  await consumer.connect();
  await consumer.subscribe({ topics: [TOPICS.telemetryRaw, TOPICS.telemetryDlq], fromBeginning: true });
  await consumer.run({
    eachMessage: ({ topic, message }) => {
      const seen: SeenMessage = {
        key: message.key?.toString(),
        correlationId: getCorrelationId(message.headers),
        value: JSON.parse(message.value?.toString() ?? "null") as unknown,
      };
      (topic === TOPICS.telemetryRaw ? rawSeen : dlqSeen).push(seen);
      return Promise.resolve();
    },
  });
});

afterAll(async () => {
  await consumer.disconnect().catch(() => undefined);
  await admin.deleteGroups([consumerGroup]).catch(() => undefined);
  await admin.disconnect().catch(() => undefined);
  // Limpieza de los datos de esta corrida: dispositivos, vehículos y tenants (en ese orden, por las claves foráneas).
  if (tenantIds.length > 0) {
    await db.query("DELETE FROM devices WHERE tenant_id = ANY($1::uuid[])", [tenantIds]).catch(() => undefined);
    await db.query("DELETE FROM vehicles WHERE tenant_id = ANY($1::uuid[])", [tenantIds]).catch(() => undefined);
    await db.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [tenantIds]).catch(() => undefined);
  }
  await db.end().catch(() => undefined);
});

/** Espera por sondeo, nunca con un sleep fijo. */
async function waitFor<T>(what: string, probe: () => T | undefined | false, timeoutMs = 25_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = probe();
    if (result !== undefined && result !== false) return result;
    if (Date.now() > deadline) throw new Error(`Se agotaron ${timeoutMs} ms esperando: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const pointOf = (fleet: Fleet, overrides: Record<string, unknown> = {}) => ({
  eventId: randomUUID(),
  vehicleId: fleet.vehicleId,
  recordedAt: new Date(Date.now() - 10_000).toISOString(),
  lon: -75.5636,
  lat: 6.2518,
  speedMps: 11.5,
  headingDeg: 180,
  accuracyM: 6,
  mocked: false,
  lowAccuracy: false,
  ...overrides,
});

const envelopeOf = (points: unknown[]) => ({ schemaVersion: 1, sentAt: new Date().toISOString(), points });

function postBatch(fleet: Pick<Fleet, "token">, body: unknown, headers: Record<string, string> = {}) {
  return fetch(BATCHES_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${fleet.token}`, ...headers },
    body: JSON.stringify(body),
  });
}

/**
 * POST que DECLARA un cuerpo mayor que el límite (Content-Length) sin enviarlo. El gateway responde 413 en cuanto ve el
 * encabezado, sin leer el cuerpo, y Fastify cierra la conexión (`connection: close`). Si el cliente sigue escribiendo megabytes, el
 * cierre con datos sin leer llega como un reset de TCP que en Windows descarta la respuesta (`fetch` lanza `ECONNRESET` y el test
 * era intermitente). Declarando el tamaño sin enviarlo, el servidor no tiene nada sin leer y la respuesta llega siempre; además prueba
 * lo que importa: el límite se decide por el encabezado, sin recibir el cuerpo.
 */
function postDeclaringOversizedBody(fleet: Pick<Fleet, "token">, declaredBytes: number): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = request(
      BATCHES_URL,
      { method: "POST", headers: { "content-type": "application/json", "content-length": String(declaredBytes), authorization: `Bearer ${fleet.token}` } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          settled = true;
          req.destroy();
          resolve({ status: response.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown });
        });
        response.on("error", reject);
      },
    );
    req.on("error", (error) => {
      if (!settled) reject(error);
    });
    req.flushHeaders();
  });
}

const rawEventsOf = (vehicleId: string): { seen: SeenMessage; event: TelemetryRawEvent }[] =>
  rawSeen.filter((seen) => seen.key === vehicleId).map((seen) => ({ seen, event: telemetryRawEventSchema.parse(seen.value) }));

const dlqMessagesOf = (vehicleId: string): { seen: SeenMessage; message: TelemetryDlqMessage }[] =>
  dlqSeen.filter((seen) => seen.key === vehicleId).map((seen) => ({ seen, message: telemetryDlqMessageSchema.parse(seen.value) }));

const countBy = (ids: readonly (string | null)[]): Map<string | null, number> => {
  const counts = new Map<string | null, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
};

describe("POST /v1/telemetry/batches contra el stack real", () => {
  it("un lote mixto devuelve el ACK esperado, publica los válidos en telemetry.raw y cada rechazado UNA vez en telemetry.dlq; reenviarlo da el mismo ACK", async () => {
    const fleet = await createFleet("mixed");
    const otherVehicle = randomUUID();
    const valid1 = pointOf(fleet);
    const valid2 = pointOf(fleet);
    const invalid = pointOf(fleet, { lat: 999 });
    const mismatch = pointOf(fleet, { vehicleId: otherVehicle });
    const future = pointOf(fleet, { recordedAt: new Date(Date.now() + 3_600_000).toISOString() });
    // 30 días: más viejo que la antigüedad máxima por defecto del gateway (7 días).
    const stale = pointOf(fleet, { recordedAt: new Date(Date.now() - 30 * 86_400_000).toISOString() });
    const batch = envelopeOf([valid1, valid2, invalid, mismatch, future, stale, valid1]);
    const correlationId = `e2e-${runId}-mixed`;

    const response = await postBatch(fleet, batch, { "x-correlation-id": correlationId });

    expect(response.status).toBe(202);
    expect(response.headers.get("x-correlation-id")).toBe(correlationId);
    const ack = batchAckSchema.parse(await response.json());
    expect(ack.accepted).toEqual([valid1.eventId, valid2.eventId]);
    expect(ack.rejected.map(({ index, eventId, reason }) => ({ index, eventId, reason }))).toEqual([
      { index: 2, eventId: invalid.eventId, reason: "invalid_schema" },
      { index: 3, eventId: mismatch.eventId, reason: "vehicle_mismatch" },
      { index: 4, eventId: future.eventId, reason: "future_timestamp" },
      { index: 5, eventId: stale.eventId, reason: "stale_timestamp" },
    ]);
    expect(ack.schemaVersion).toBe(1);
    expect(Math.abs(Date.parse(ack.serverTime) - Date.now())).toBeLessThan(60_000);
    // Ningún detalle del ACK lleva coordenadas ni vehículos.
    expect(JSON.stringify(ack.rejected)).not.toMatch(/6\.2518|-75\.5636|999/);
    expect(JSON.stringify(ack.rejected)).not.toContain(otherVehicle);

    // Centinela: mismo vehículo (misma key, misma partición) y, por tanto, llega DESPUÉS de todo lo anterior. Cuando
    // aparece, sabemos que no falta nada ni va a llegar nada de más del primer lote.
    const sentinelValid = pointOf(fleet);
    const sentinelInvalid = pointOf(fleet, { lat: 999 });
    expect((await postBatch(fleet, envelopeOf([sentinelValid, sentinelInvalid]), { "x-correlation-id": `${correlationId}-sentinel` })).status).toBe(202);
    await waitFor("el centinela válido en telemetry.raw", () => rawEventsOf(fleet.vehicleId).some(({ event }) => event.point.eventId === sentinelValid.eventId));
    await waitFor("el centinela rechazado en telemetry.dlq", () => dlqMessagesOf(fleet.vehicleId).some(({ message }) => message.eventId === sentinelInvalid.eventId));

    // telemetry.raw: los dos válidos, una vez cada uno (el duplicado del lote se publicó una sola vez), con key y correlationId.
    const firstBatchRaw = rawEventsOf(fleet.vehicleId).filter(({ seen }) => seen.correlationId === correlationId);
    expect(firstBatchRaw.map(({ event }) => event.point.eventId)).toEqual([valid1.eventId, valid2.eventId]);
    for (const { seen, event } of firstBatchRaw) {
      expect(seen.key).toBe(fleet.vehicleId);
      expect(event).toMatchObject({ schemaVersion: 1, tenantId: fleet.tenantId, deviceId: fleet.deviceId });
      expect(Math.abs(Date.parse(event.receivedAt) - Date.now())).toBeLessThan(60_000);
    }
    expect(firstBatchRaw[0]?.event.point).toEqual(valid1);
    // Lo rechazado no llega a raw.
    const rawIds = rawEventsOf(fleet.vehicleId).map(({ event }) => event.point.eventId);
    for (const rejectedId of [invalid.eventId, mismatch.eventId, future.eventId, stale.eventId, sentinelInvalid.eventId]) expect(rawIds).not.toContain(rejectedId);

    // telemetry.dlq: cada rechazado UNA vez, con motivo, ids conocidos, correlationId y el punto tal como llegó.
    const firstBatchDlq = dlqMessagesOf(fleet.vehicleId).filter(({ seen }) => seen.correlationId === correlationId);
    expect(firstBatchDlq).toHaveLength(4);
    expect([...countBy(firstBatchDlq.map(({ message }) => message.eventId)).values()]).toEqual([1, 1, 1, 1]);
    const byEvent = new Map(firstBatchDlq.map(({ message }) => [message.eventId, message]));
    for (const [point, code] of [
      [invalid, "invalid_schema"],
      [mismatch, "vehicle_mismatch"],
      [future, "future_timestamp"],
      [stale, "stale_timestamp"],
    ] as const) {
      const message = byEvent.get(point.eventId);
      expect(message).toMatchObject({
        schemaVersion: 1,
        source: "ingest-gateway",
        reason: { code },
        tenantId: fleet.tenantId,
        deviceId: fleet.deviceId,
        vehicleId: fleet.vehicleId,
        eventId: point.eventId,
        attempts: 0,
        originalPayload: point,
      });
      expect(message?.reason.message).not.toMatch(/6\.2518|-75\.5636|999/);
    }

    // Reenviar el mismo lote: mismo ACK (los válidos siguen en accepted, los rechazos siguen rechazados).
    const retry = await postBatch(fleet, batch, { "x-correlation-id": `${correlationId}-retry` });
    expect(retry.status).toBe(202);
    const retryAck: BatchAck = batchAckSchema.parse(await retry.json());
    expect({ ...retryAck, serverTime: "" }).toEqual({ ...ack, serverTime: "" });
  });

  it("un punto de más de INGEST_GATEWAY_MAX_POINT_BYTES se rechaza como invalid_schema y a la DLQ llega solo su inicio con su tamaño original", async () => {
    const fleet = await createFleet("oversized");
    const huge = pointOf(fleet, { relleno: "x".repeat(20_000) });
    const sentinelValid = pointOf(fleet);

    const response = await postBatch(fleet, envelopeOf([huge, sentinelValid]));

    expect(response.status).toBe(202);
    const ack = batchAckSchema.parse(await response.json());
    expect(ack.accepted).toEqual([sentinelValid.eventId]);
    expect(ack.rejected.map(({ index, eventId, reason }) => ({ index, eventId, reason }))).toEqual([{ index: 0, eventId: huge.eventId, reason: "invalid_schema" }]);
    const entry = await waitFor("el punto enorme en telemetry.dlq", () => dlqMessagesOf(fleet.vehicleId).find(({ message }) => message.eventId === huge.eventId));
    expect(entry.message.truncatedFromBytes).toBe(Buffer.byteLength(JSON.stringify(huge), "utf8"));
    const preview = entry.message.originalPayload;
    if (typeof preview !== "string") throw new Error("originalPayload debía ser el inicio del punto (un string)");
    expect(preview.length).toBeLessThan(2_000);
    expect(JSON.stringify(huge).startsWith(preview)).toBe(true);
    await waitFor("el punto válido en telemetry.raw", () => rawEventsOf(fleet.vehicleId).some(({ event }) => event.point.eventId === sentinelValid.eventId));
  });

  it("un envelope roto responde 400 invalid_envelope y NO se publica nada en la DLQ ni en raw", async () => {
    const fleet = await createFleet("broken-envelope");
    const marker = pointOf(fleet);

    const broken = await postBatch(fleet, { ...envelopeOf([marker]), schemaVersion: 2 });
    const invalidJson = await fetch(BATCHES_URL, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${fleet.token}` }, body: "{no es json" });

    expect(broken.status).toBe(400);
    expect(apiErrorSchema.parse(await broken.json()).error.code).toBe("invalid_envelope");
    expect(invalidJson.status).toBe(400);
    expect(apiErrorSchema.parse(await invalidJson.json()).error.code).toBe("invalid_envelope");

    const sentinel = pointOf(fleet, { lat: 999 });
    expect((await postBatch(fleet, envelopeOf([sentinel]))).status).toBe(202);
    await waitFor("el centinela en telemetry.dlq", () => dlqMessagesOf(fleet.vehicleId).some(({ message }) => message.eventId === sentinel.eventId));
    expect(dlqMessagesOf(fleet.vehicleId).map(({ message }) => message.eventId)).toEqual([sentinel.eventId]);
    expect(rawEventsOf(fleet.vehicleId)).toEqual([]);
  });

  it("sin token, con token malformado, desconocido o revocado responde el mismo 401 unauthorized, y nada llega a Kafka", async () => {
    const revoked = await createFleet("revoked", { revoked: true });
    const unknownToken = deviceTokenSchema.parse(`${DEVICE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`);
    const batch = envelopeOf([pointOf(revoked)]);

    const attempts = await Promise.all([
      fetch(BATCHES_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(batch) }),
      postBatch({ token: "fdt_corto" }, batch),
      postBatch({ token: unknownToken }, batch),
      postBatch(revoked, batch),
    ]);

    const bodies = await Promise.all(attempts.map((response) => response.text()));
    expect(attempts.map((response) => response.status)).toEqual([401, 401, 401, 401]);
    expect(new Set(bodies).size).toBe(1);
    expect(apiErrorSchema.parse(JSON.parse(bodies[0] ?? "")).error.code).toBe("unauthorized");
    expect(rawEventsOf(revoked.vehicleId)).toEqual([]);
    expect(dlqMessagesOf(revoked.vehicleId)).toEqual([]);
  });

  // Hallazgo ALTO de la segunda pasada: el límite de 401 por IP se consultaba antes de autenticar y daba 429 a cualquier token. Tras el
  // CGNAT de un operador móvil comparten IP cientos de dispositivos de tenants distintos: uno con un token rotado los dejaba fuera a todos.
  it("tras agotar el límite de 401 de una IP, un token VÁLIDO desde esa IP sigue pasando (202) y uno inválido recibe 429 con Retry-After", async () => {
    const fleet = await createFleet("ip-limit");
    const clientIp = `203.0.113.${1 + Math.floor(Math.random() * 253)}`;
    const from = { "x-forwarded-for": clientIp };
    const guess = () => postBatch({ token: `${DEVICE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}` }, envelopeOf([pointOf(fleet)]), from);

    const statuses: number[] = [];
    for (let i = 0; i < E2E_AUTH_FAILURE_LIMIT_MAX; i += 1) statuses.push((await guess()).status);
    const limited = await guess();

    expect(statuses).toEqual(Array.from({ length: E2E_AUTH_FAILURE_LIMIT_MAX }, () => 401));
    expect(limited.status).toBe(429);
    expect(apiErrorSchema.parse(await limited.json()).error.code).toBe("rate_limited");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);

    const valid = pointOf(fleet);
    const accepted = await postBatch(fleet, envelopeOf([valid]), from);
    expect(accepted.status).toBe(202);
    expect(batchAckSchema.parse(await accepted.json()).accepted).toEqual([valid.eventId]);
    await waitFor("el punto del token válido en telemetry.raw", () => rawEventsOf(fleet.vehicleId).some(({ event }) => event.point.eventId === valid.eventId));
    expect((await guess()).status).toBe(429);
    // Otra IP no se ve afectada: un token inválido sigue dando 401.
    expect((await postBatch({ token: `${DEVICE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}` }, envelopeOf([pointOf(fleet)]), { "x-forwarded-for": "198.51.100.77" })).status).toBe(401);
  });

  it("un cuerpo de más del límite responde 413 y un Content-Type que no es JSON responde 415", async () => {
    const fleet = await createFleet("limits");

    const tooLarge = await postDeclaringOversizedBody(fleet, 1_200_000);
    const textPlain = await fetch(BATCHES_URL, {
      method: "POST",
      headers: { "content-type": "text/plain", authorization: `Bearer ${fleet.token}` },
      body: JSON.stringify(envelopeOf([pointOf(fleet)])),
    });

    expect(tooLarge.status).toBe(413);
    expect(apiErrorSchema.parse(tooLarge.json).error.code).toBe("payload_too_large");
    expect(textPlain.status).toBe(415);
    expect(apiErrorSchema.parse(await textPlain.json()).error.code).toBe("unsupported_media_type");
  });
});
