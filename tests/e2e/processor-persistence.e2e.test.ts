import { randomBytes, randomUUID } from "node:crypto";
import {
  batchAckSchema,
  DEVICE_TOKEN_PREFIX,
  deviceTokenSchema,
  telemetryDlqMessageSchema,
  TOPICS,
  type TelemetryDlqMessage,
} from "@fleet/contracts";
import { createAdmin, createConsumer, createKafka, createLogger, createPool, getCorrelationId, loadConfig, sha256Hex } from "@fleet/platform";
import { Client, type Pool } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import "./provided-context.js";
import { e2eConfigSchema } from "./support.js";

// Flujo e2e de la persistencia: HTTP (ingest-gateway) -> Kafka (telemetry.raw) -> processor -> TimescaleDB, con
// telemetry.dlq para lo que el processor rechaza. Gateway y processor los levantó el arnés desde dist/. Los datos
// (tenant, vehículo, dispositivo, puntos) son de esta corrida y se borran al terminar. La base se consulta con el rol de
// solo lectura (`fleet_ro`), como lo haría un consumidor externo.
const gatewayUrl = inject("gatewayUrl");
const runId = inject("runId");
const config = loadConfig(e2eConfigSchema);
const BATCHES_URL = `${gatewayUrl}/v1/telemetry/batches`;
const logger = createLogger({ service: "e2e-processor-persistence", level: "error" });

const kafka = createKafka({ brokers: config.KAFKA_BROKERS, clientId: `e2e-processor-persistence-${runId}`, logger });
const admin = createAdmin(kafka);
const dlqGroup = `e2e-processor-persistence-${runId}`;
const dlqConsumer = createConsumer(kafka, { groupId: dlqGroup });
const seed = new Client({ connectionString: config.DATABASE_ADMIN_URL });
let readOnly: Pool;

interface DlqSeen {
  key: string | undefined;
  correlationId: string | undefined;
  message: TelemetryDlqMessage;
}
const dlqSeen: DlqSeen[] = [];

interface Fleet {
  tenantId: string;
  vehicleId: string;
  deviceId: string;
  token: string;
}
const tenantIds: string[] = [];

/** Tenant, vehículo y dispositivo aislados por runId. */
async function createFleet(label: string): Promise<Fleet> {
  const tenantId = randomUUID();
  const vehicleId = randomUUID();
  const deviceId = randomUUID();
  const token = deviceTokenSchema.parse(`${DEVICE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`);
  await seed.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [tenantId, `e2e-${runId}-${label}`]);
  tenantIds.push(tenantId);
  await seed.query("INSERT INTO vehicles (id, tenant_id, plate) VALUES ($1, $2, $3)", [vehicleId, tenantId, `E${vehicleId.slice(0, 5).toUpperCase()}`]);
  await seed.query("INSERT INTO devices (id, tenant_id, vehicle_id, token_hash) VALUES ($1, $2, $3, $4)", [deviceId, tenantId, vehicleId, sha256Hex(token)]);
  return { tenantId, vehicleId, deviceId, token };
}

// Los puntos de esta corrida caen en la última hora; las consultas y la limpieza usan este rango (es una hypertable).
const RUN_START_MS = Date.now();
const rangeFrom = () => new Date(RUN_START_MS - 3_600_000);
const rangeTo = () => new Date(Date.now() + 3_600_000);

beforeAll(async () => {
  await seed.connect();
  readOnly = createPool({ connectionString: config.DATABASE_RO_URL, applicationName: `e2e-fleet-ro-${runId}`, logger, max: 2 });
  await admin.connect();
  await dlqConsumer.connect();
  await dlqConsumer.subscribe({ topic: TOPICS.telemetryDlq, fromBeginning: true });
  await dlqConsumer.run({
    eachMessage: ({ message }) => {
      const parsed = telemetryDlqMessageSchema.safeParse(JSON.parse(message.value?.toString() ?? "null"));
      // Solo los mensajes con el contrato estricto: la DLQ real puede traer restos de corridas anteriores.
      if (parsed.success) dlqSeen.push({ key: message.key?.toString(), correlationId: getCorrelationId(message.headers), message: parsed.data });
      return Promise.resolve();
    },
  });
});

afterAll(async () => {
  await dlqConsumer.disconnect().catch(() => undefined);
  await admin.deleteGroups([dlqGroup]).catch(() => undefined);
  await admin.disconnect().catch(() => undefined);
  await readOnly?.end().catch(() => undefined);
  // Limpieza de los datos de esta corrida: telemetría, dispositivos, vehículos y tenants (por las claves foráneas).
  if (tenantIds.length > 0) {
    await seed.query("DELETE FROM telemetry WHERE tenant_id = ANY($1::uuid[]) AND recorded_at >= $2 AND recorded_at < $3", [tenantIds, rangeFrom(), rangeTo()]).catch(() => undefined);
    await seed.query("DELETE FROM devices WHERE tenant_id = ANY($1::uuid[])", [tenantIds]).catch(() => undefined);
    await seed.query("DELETE FROM vehicles WHERE tenant_id = ANY($1::uuid[])", [tenantIds]).catch(() => undefined);
    await seed.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [tenantIds]).catch(() => undefined);
  }
  await seed.end().catch(() => undefined);
});

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

const pointOf = (fleet: Fleet, offsetMs: number, overrides: Record<string, unknown> = {}) => ({
  eventId: randomUUID(),
  vehicleId: fleet.vehicleId,
  recordedAt: new Date(Date.now() - 60_000 + offsetMs).toISOString(),
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

function postBatch(fleet: Pick<Fleet, "token">, body: unknown, correlationId: string) {
  return fetch(BATCHES_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${fleet.token}`, "x-correlation-id": correlationId },
    body: JSON.stringify(body),
  });
}

interface StoredRow {
  event_id: string;
  tenant_id: string;
  vehicle_id: string;
  device_id: string;
  recorded_at: Date;
  received_at: Date;
  lon: number;
  lat: number;
}

/** Lo persistido de un vehículo de un tenant, leído con `fleet_ro`. */
async function storedRows(fleet: Fleet): Promise<StoredRow[]> {
  const { rows } = await readOnly.query<StoredRow>(
    `SELECT event_id, tenant_id, vehicle_id, device_id, recorded_at, received_at, ST_X(geom) AS lon, ST_Y(geom) AS lat
       FROM telemetry
      WHERE tenant_id = $1 AND vehicle_id = $2 AND recorded_at >= $3 AND recorded_at < $4
      ORDER BY recorded_at, event_id`,
    [fleet.tenantId, fleet.vehicleId, rangeFrom(), rangeTo()],
  );
  return rows;
}

const processorDlqOf = (fleet: Fleet) => dlqSeen.filter((seen) => seen.message.source === "processor" && seen.message.vehicleId === fleet.vehicleId);

describe("HTTP -> Kafka -> processor -> TimescaleDB contra el stack real", () => {
  it(
    "un lote con válidos, un duplicado, un inválido de esquema y un punto fuera de Colombia: cada válido queda UNA vez con sus coordenadas, el de fuera va a la DLQ del processor, y reenviar el lote no cambia nada",
    async () => {
      const fleet = await createFleet("persist");
      const correlationId = `e2e-${runId}-persist`;
      const medellin = pointOf(fleet, 0, { lon: -75.5636, lat: 6.2518 });
      const bogota = pointOf(fleet, 1_000, { lon: -74.0721, lat: 4.711 });
      const sanAndres = pointOf(fleet, 2_000, { lon: -81.7003, lat: 12.5847 });
      const invalid = pointOf(fleet, 3_000, { lat: 999 });
      const madrid = pointOf(fleet, 4_000, { lon: -3.7038, lat: 40.4168 });
      const batch = envelopeOf([medellin, bogota, sanAndres, invalid, madrid, medellin]);

      const response = await postBatch(fleet, batch, correlationId);

      // El gateway acepta el punto de Madrid (es válido por esquema): el rechazo es regla de dominio del processor.
      expect(response.status).toBe(202);
      const ack = batchAckSchema.parse(await response.json());
      expect(ack.accepted).toEqual([medellin.eventId, bogota.eventId, sanAndres.eventId, madrid.eventId]);
      expect(ack.rejected.map(({ index, eventId, reason }) => ({ index, eventId, reason }))).toEqual([
        { index: 3, eventId: invalid.eventId, reason: "invalid_schema" },
      ]);

      // Centinela: mismo vehículo (misma key, misma partición, mismo consumer), así que se procesa DESPUÉS de todo lo
      // anterior. Cuando aparece, no falta nada ni va a llegar nada de más del primer lote.
      const sentinel1 = pointOf(fleet, 5_000);
      expect((await postBatch(fleet, envelopeOf([sentinel1]), `${correlationId}-sentinel-1`)).status).toBe(202);
      const afterFirst = await waitFor("los tres válidos y el centinela en telemetry (fleet_ro)", async () => {
        const rows = await storedRows(fleet);
        return rows.some((row) => row.event_id === sentinel1.eventId) ? rows : undefined;
      });

      // telemetry: exactamente una fila por válido (el duplicado del lote y el reintento no suman), con sus coordenadas.
      expect(afterFirst.map((row) => row.event_id).sort()).toEqual([medellin, bogota, sanAndres, sentinel1].map((p) => p.eventId).sort());
      const byId = new Map(afterFirst.map((row) => [row.event_id, row]));
      for (const point of [medellin, bogota, sanAndres]) {
        const row = byId.get(point.eventId);
        // ST_X es la longitud y ST_Y la latitud.
        expect(row?.lon).toBeCloseTo(point.lon, 6);
        expect(row?.lat).toBeCloseTo(point.lat, 6);
        expect(row).toMatchObject({ tenant_id: fleet.tenantId, vehicle_id: fleet.vehicleId, device_id: fleet.deviceId });
        // El tiempo es el del fix GPS del dispositivo, y la hora del servidor va aparte.
        expect(row?.recorded_at.toISOString()).toBe(point.recordedAt);
        expect(Math.abs((row?.received_at.getTime() ?? 0) - Date.now())).toBeLessThan(120_000);
      }
      // Lo rechazado no está en telemetry: ni el inválido (lo frenó el gateway) ni el de fuera de Colombia.
      expect(byId.has(invalid.eventId)).toBe(false);
      expect(byId.has(madrid.eventId)).toBe(false);

      // telemetry.dlq: el punto de Madrid UNA vez, del processor, con el motivo, los ids y el correlationId del lote.
      const madridEntries = await waitFor("el punto de Madrid en telemetry.dlq", () => {
        const entries = processorDlqOf(fleet).filter((seen) => seen.message.eventId === madrid.eventId);
        return entries.length > 0 ? entries : undefined;
      });
      expect(madridEntries).toHaveLength(1);
      expect(madridEntries[0]?.key).toBe(fleet.vehicleId);
      expect(madridEntries[0]?.correlationId).toBe(correlationId);
      expect(madridEntries[0]?.message).toMatchObject({
        schemaVersion: 1,
        source: "processor",
        reason: { code: "outside_operating_area" },
        tenantId: fleet.tenantId,
        deviceId: fleet.deviceId,
        vehicleId: fleet.vehicleId,
        eventId: madrid.eventId,
        attempts: 0,
      });
      expect(madridEntries[0]?.message.reason.message).not.toMatch(/-3\.7038|40\.4168/);
      // Los válidos no van a la DLQ del processor.
      expect(processorDlqOf(fleet).map((seen) => seen.message.eventId)).not.toContain(medellin.eventId);

      // Idempotencia de punta a punta: el mismo lote otra vez da el mismo ACK y el conteo de filas no cambia.
      const retry = await postBatch(fleet, batch, `${correlationId}-retry`);
      expect(retry.status).toBe(202);
      expect({ ...batchAckSchema.parse(await retry.json()), serverTime: "" }).toEqual({ ...ack, serverTime: "" });

      const sentinel2 = pointOf(fleet, 6_000);
      expect((await postBatch(fleet, envelopeOf([sentinel2]), `${correlationId}-sentinel-2`)).status).toBe(202);
      const afterRetry = await waitFor("el segundo centinela en telemetry (fleet_ro)", async () => {
        const rows = await storedRows(fleet);
        return rows.some((row) => row.event_id === sentinel2.eventId) ? rows : undefined;
      });
      // Tres válidos + dos centinelas: los reenviados no sumaron ninguna fila.
      expect(afterRetry).toHaveLength(5);
      expect(new Set(afterRetry.map((row) => row.event_id)).size).toBe(5);
      // (La DLQ no se deduplica: cada vez que el processor consume el punto de Madrid lo registra otra vez; por eso aquí
      // no se afirma un conteo de la DLQ tras el reenvío.)
    },
    90_000,
  );
});
