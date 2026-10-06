import { randomBytes, randomUUID } from "node:crypto";
import {
  alertEventSchema,
  batchAckSchema,
  DEVICE_TOKEN_PREFIX,
  deviceTokenSchema,
  TOPICS,
  vehicleStateEventSchema,
  type AlertEvent,
  type VehicleStateEvent,
} from "@fleet/contracts";
import { createAdmin, createConsumer, createKafka, createLogger, createPool, getCorrelationId, loadConfig, sha256Hex } from "@fleet/platform";
import { Client, type Pool } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import "./provided-context.js";
import { e2eConfigSchema } from "./support.js";

// Flujo e2e del estado de la flota: HTTP (ingest-gateway) -> Kafka (telemetry.raw) -> processor -> TimescaleDB (vehicle_state y alerts) ->
// Kafka (vehicle.state y fleet.alerts). Gateway y processor los levantó el arnés desde dist/. Los datos (tenant, vehículo, dispositivo, zona,
// puntos) son de esta corrida y se borran al terminar. La base se consulta con el rol de solo lectura (`fleet_ro`), como lo haría fleet-api.
const gatewayUrl = inject("gatewayUrl");
const runId = inject("runId");
const config = loadConfig(e2eConfigSchema);
const BATCHES_URL = `${gatewayUrl}/v1/telemetry/batches`;
const logger = createLogger({ service: "e2e-processor-fleet-state", level: "error" });

const kafka = createKafka({ brokers: config.KAFKA_BROKERS, clientId: `e2e-processor-fleet-state-${runId}`, logger });
const admin = createAdmin(kafka);
const eventsGroup = `e2e-processor-fleet-state-${runId}`;
const eventsConsumer = createConsumer(kafka, { groupId: eventsGroup });
const seed = new Client({ connectionString: config.DATABASE_ADMIN_URL });
let readOnly: Pool;

interface Seen<T> {
  key: string | undefined;
  correlationId: string | undefined;
  event: T;
}
const stateSeen: Seen<VehicleStateEvent>[] = [];
const alertsSeen: Seen<AlertEvent>[] = [];

interface Fleet {
  tenantId: string;
  vehicleId: string;
  deviceId: string;
  zoneId: string;
  token: string;
}
const tenantIds: string[] = [];

// Rectángulo de ~1 km en Medellín (lon -75.57..-75.56, lat 6.25..6.26): la zona CRÍTICA sembrada, y un punto dentro de ella.
const ZONE_POLYGON = "POLYGON((-75.57 6.25, -75.56 6.25, -75.56 6.26, -75.57 6.26, -75.57 6.25))";
const INSIDE = { lon: -75.565, lat: 6.255 };

/** Tenant, vehículo, dispositivo y una zona crítica, aislados por runId. */
async function createFleet(label: string): Promise<Fleet> {
  const tenantId = randomUUID();
  const vehicleId = randomUUID();
  const deviceId = randomUUID();
  const zoneId = randomUUID();
  const token = deviceTokenSchema.parse(`${DEVICE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`);
  await seed.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [tenantId, `e2e-${runId}-${label}`]);
  tenantIds.push(tenantId);
  await seed.query("INSERT INTO vehicles (id, tenant_id, plate) VALUES ($1, $2, $3)", [vehicleId, tenantId, `E${vehicleId.slice(0, 5).toUpperCase()}`]);
  await seed.query("INSERT INTO devices (id, tenant_id, vehicle_id, token_hash) VALUES ($1, $2, $3, $4)", [deviceId, tenantId, vehicleId, sha256Hex(token)]);
  await seed.query("INSERT INTO zones (zone_id, tenant_id, name, kind, geom) VALUES ($1, $2, $3, 'critical', ST_GeomFromText($4, 4326))", [
    zoneId,
    tenantId,
    `Zona crítica e2e ${runId}`,
    ZONE_POLYGON,
  ]);
  return { tenantId, vehicleId, deviceId, zoneId, token };
}

// Los puntos van fechados HACIA ATRÁS (recordedAt entre hace 90 y hace 15 minutos): dentro de la antigüedad que acepta el gateway y sin
// esperar 20 minutos de verdad; la alerta se calcula con la hora del fix.
const RUN_START_MS = Date.now();
const minutesAgo = (minutes: number) => new Date(RUN_START_MS - minutes * 60_000).toISOString();
const rangeFrom = () => new Date(RUN_START_MS - 3 * 3_600_000);
const rangeTo = () => new Date(Date.now() + 3_600_000);

beforeAll(async () => {
  await seed.connect();
  readOnly = createPool({ connectionString: config.DATABASE_RO_URL, applicationName: `e2e-fleet-state-ro-${runId}`, logger, max: 2 });
  await admin.connect();
  await eventsConsumer.connect();
  await eventsConsumer.subscribe({ topic: TOPICS.vehicleState, fromBeginning: true });
  await eventsConsumer.subscribe({ topic: TOPICS.fleetAlerts, fromBeginning: true });
  await eventsConsumer.run({
    eachMessage: ({ topic, message }) => {
      const value: unknown = JSON.parse(message.value?.toString() ?? "null");
      const meta = { key: message.key?.toString(), correlationId: getCorrelationId(message.headers) };
      // Solo con el contrato ESTRICTO: los tópicos reales pueden traer restos de otras corridas.
      if (topic === TOPICS.vehicleState) {
        const parsed = vehicleStateEventSchema.safeParse(value);
        if (parsed.success) stateSeen.push({ ...meta, event: parsed.data });
      } else {
        const parsed = alertEventSchema.safeParse(value);
        if (parsed.success) alertsSeen.push({ ...meta, event: parsed.data });
      }
      return Promise.resolve();
    },
  });
});

afterAll(async () => {
  await eventsConsumer.disconnect().catch(() => undefined);
  await admin.deleteGroups([eventsGroup]).catch(() => undefined);
  await admin.disconnect().catch(() => undefined);
  await readOnly?.end().catch(() => undefined);
  // Limpieza de los datos de esta corrida, en el orden de las claves foráneas: alertas, estado, zonas, telemetría, dispositivos, vehículos, tenants.
  if (tenantIds.length > 0) {
    await seed.query("DELETE FROM alerts WHERE tenant_id = ANY($1::uuid[])", [tenantIds]).catch(() => undefined);
    await seed.query("DELETE FROM vehicle_state WHERE tenant_id = ANY($1::uuid[])", [tenantIds]).catch(() => undefined);
    await seed.query("DELETE FROM zones WHERE tenant_id = ANY($1::uuid[])", [tenantIds]).catch(() => undefined);
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

const pointOf = (fleet: Fleet, recordedAt: string, speedMps: number) => ({
  eventId: randomUUID(),
  vehicleId: fleet.vehicleId,
  recordedAt,
  lon: INSIDE.lon,
  lat: INSIDE.lat,
  speedMps,
  headingDeg: 90,
  accuracyM: 6,
  mocked: false,
  lowAccuracy: false,
});

const envelopeOf = (points: unknown[]) => ({ schemaVersion: 1, sentAt: new Date().toISOString(), points });

async function postBatch(fleet: Pick<Fleet, "token">, points: ReturnType<typeof pointOf>[], correlationId: string): Promise<void> {
  const response = await fetch(BATCHES_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${fleet.token}`, "x-correlation-id": correlationId },
    body: JSON.stringify(envelopeOf(points)),
  });
  expect(response.status).toBe(202);
  const ack = batchAckSchema.parse(await response.json());
  expect(ack.accepted).toEqual(points.map((point) => point.eventId));
  expect(ack.rejected).toEqual([]);
}

interface StateRow {
  movement: string;
  stopped_since: Date | null;
  recorded_at: Date;
  zone_ids: string[];
  lon: number;
  lat: number;
  seq: string;
}
interface AlertRow {
  alert_id: string;
  type: string;
  zone_id: string | null;
  started_at: Date;
  resolved_at: Date | null;
  seq: string;
}

async function stateOf(fleet: Fleet): Promise<StateRow | undefined> {
  const { rows } = await readOnly.query<StateRow>(
    `SELECT movement, stopped_since, recorded_at, zone_ids, ST_X(geom) AS lon, ST_Y(geom) AS lat, seq::text AS seq
       FROM vehicle_state WHERE tenant_id = $1 AND vehicle_id = $2`,
    [fleet.tenantId, fleet.vehicleId],
  );
  return rows[0];
}

async function alertsOf(fleet: Fleet): Promise<AlertRow[]> {
  const { rows } = await readOnly.query<AlertRow>(
    "SELECT alert_id, type, zone_id, started_at, resolved_at, seq::text AS seq FROM alerts WHERE tenant_id = $1 AND vehicle_id = $2 ORDER BY started_at",
    [fleet.tenantId, fleet.vehicleId],
  );
  return rows;
}

const stateEventsOf = (fleet: Fleet) => stateSeen.filter((seen) => seen.event.state.vehicleId === fleet.vehicleId);
const alertEventsOf = (fleet: Fleet) => alertsSeen.filter((seen) => seen.event.alert.vehicleId === fleet.vehicleId);

describe("HTTP -> Kafka -> processor -> vehicle_state y alerts -> vehicle.state y fleet.alerts contra el stack real", () => {
  it(
    "un vehículo que se detiene 25 minutos en una zona crítica queda stopped con stoppedSince = el primer fix detenido y levanta UNA alerta (base y fleet.alerts); al moverse la alerta se resuelve; reenviar puntos viejos no hace retroceder nada",
    async () => {
      const fleet = await createFleet("state");
      const batchCorrelation = `e2e-${runId}-state-1`;
      const firstStopped = minutesAgo(70);

      // Lote 1: un punto en movimiento y luego seis puntos detenidos dentro de la zona, de hace 70 a hace 45 min (25 min de detención).
      const stopBatch = [
        pointOf(fleet, minutesAgo(80), 9),
        ...[70, 65, 60, 55, 50, 45].map((ago) => pointOf(fleet, minutesAgo(ago), 0)),
      ];
      await postBatch(fleet, stopBatch, batchCorrelation);

      // vehicle_state: stopped, con stoppedSince = recordedAt del PRIMER punto detenido (hora del fix, no la del servidor), en la zona.
      const stopped = await waitFor("vehicle_state stopped con el último punto del lote (fleet_ro)", async () => {
        const row = await stateOf(fleet);
        return row?.recorded_at.toISOString() === minutesAgo(45) ? row : undefined;
      });
      expect(stopped.movement).toBe("stopped");
      expect(stopped.stopped_since?.toISOString()).toBe(firstStopped);
      expect(stopped.zone_ids).toEqual([fleet.zoneId]);
      // ST_X es la longitud y ST_Y la latitud.
      expect(stopped.lon).toBeCloseTo(INSIDE.lon, 6);
      expect(stopped.lat).toBeCloseTo(INSIDE.lat, 6);

      // alerts: UNA alerta critical_zone_stop, en la zona, que empezó con el primer fix detenido y sigue activa.
      const raised = await waitFor("la alerta critical_zone_stop en la base (fleet_ro)", async () => {
        const rows = await alertsOf(fleet);
        return rows.length > 0 ? rows : undefined;
      });
      expect(raised).toHaveLength(1);
      expect(raised[0]).toMatchObject({ type: "critical_zone_stop", zone_id: fleet.zoneId, resolved_at: null });
      expect(raised[0]?.started_at.toISOString()).toBe(firstStopped);
      const alertId = raised[0]?.alert_id ?? "";

      // fleet.alerts: el alta, con key = vehicleId, el correlationId del lote HTTP y los datos de la base.
      const alertEvent = await waitFor("el alta de la alerta en fleet.alerts", () => alertEventsOf(fleet).find((seen) => seen.event.alert.alertId === alertId && seen.event.alert.resolvedAt === null));
      expect(alertEvent.key).toBe(fleet.vehicleId);
      expect(alertEvent.correlationId).toBe(batchCorrelation);
      expect(alertEvent.event).toMatchObject({
        schemaVersion: 1,
        tenantId: fleet.tenantId,
        alert: { type: "critical_zone_stop", zoneId: fleet.zoneId, zoneName: `Zona crítica e2e ${runId}`, startedAt: firstStopped, resolvedAt: null },
      });

      // vehicle.state: al menos un evento con el estado stopped, la misma key y el correlationId del lote; su seq es el de la base.
      const stateEvent = await waitFor("vehicle.state con el estado stopped final", () =>
        stateEventsOf(fleet).find((seen) => seen.event.state.movement === "stopped" && seen.event.state.recordedAt === minutesAgo(45)),
      );
      expect(stateEvent.key).toBe(fleet.vehicleId);
      expect(stateEvent.correlationId).toBe(batchCorrelation);
      expect(stateEvent.event).toMatchObject({ schemaVersion: 1, tenantId: fleet.tenantId });
      expect(stateEvent.event.state).toMatchObject({ vehicleId: fleet.vehicleId, movement: "stopped", stoppedSince: firstStopped, zoneIds: [fleet.zoneId] });
      expect(stateEvent.event.state.seq).toBe(stopped.seq);

      // Lote 2: el vehículo se mueve (hace 30 y 25 min). La alerta se resuelve con el recordedAt del primer punto en movimiento.
      const moveCorrelation = `e2e-${runId}-state-2`;
      await postBatch(fleet, [pointOf(fleet, minutesAgo(30), 10), pointOf(fleet, minutesAgo(25), 10)], moveCorrelation);

      const moving = await waitFor("vehicle_state moving (fleet_ro)", async () => {
        const row = await stateOf(fleet);
        return row?.recorded_at.toISOString() === minutesAgo(25) ? row : undefined;
      });
      expect(moving).toMatchObject({ movement: "moving", stopped_since: null });
      expect(BigInt(moving.seq)).toBeGreaterThan(BigInt(stopped.seq));

      const resolved = await waitFor("la alerta resuelta en la base (fleet_ro)", async () => {
        const rows = await alertsOf(fleet);
        return rows[0]?.resolved_at === null ? undefined : rows;
      });
      expect(resolved).toHaveLength(1);
      expect(resolved[0]?.alert_id).toBe(alertId);
      expect(resolved[0]?.resolved_at?.toISOString()).toBe(minutesAgo(30));
      expect(BigInt(resolved[0]?.seq ?? "0")).toBeGreaterThan(BigInt(raised[0]?.seq ?? "0"));

      // fleet.alerts: la resolución, misma alertId y un seq mayor; vehicle.state: moving con stoppedSince null.
      const resolution = await waitFor("la resolución en fleet.alerts", () => alertEventsOf(fleet).find((seen) => seen.event.alert.alertId === alertId && seen.event.alert.resolvedAt !== null));
      expect(resolution.correlationId).toBe(moveCorrelation);
      expect(resolution.event.alert.resolvedAt).toBe(minutesAgo(30));
      expect(BigInt(resolution.event.alert.seq)).toBeGreaterThan(BigInt(alertEvent.event.alert.seq));
      const movingEvent = await waitFor("vehicle.state moving", () => stateEventsOf(fleet).find((seen) => seen.event.state.movement === "moving" && seen.event.state.recordedAt === minutesAgo(25)));
      expect(movingEvent.event.state).toMatchObject({ stoppedSince: null, seq: moving.seq });

      // Sin regresión ni alertas nuevas: se reenvía el lote 1 (puntos viejos, ya persistidos) seguido de un centinela más nuevo. Cuando el
      // estado refleja al centinela, el procesamiento de los reenviados ya terminó (misma key, misma partición, mismo consumer).
      const sentinel = pointOf(fleet, minutesAgo(20), 11);
      await postBatch(fleet, [...stopBatch, sentinel], `e2e-${runId}-state-3`);
      const afterReplay = await waitFor("el centinela en vehicle_state (fleet_ro)", async () => {
        const row = await stateOf(fleet);
        return row?.recorded_at.toISOString() === minutesAgo(20) ? row : undefined;
      });
      expect(afterReplay).toMatchObject({ movement: "moving", stopped_since: null });
      const finalAlerts = await alertsOf(fleet);
      expect(finalAlerts).toHaveLength(1);
      expect(finalAlerts[0]?.resolved_at?.toISOString()).toBe(minutesAgo(30));

      // Los seq de los eventos de estado de este vehículo, en el orden en que se publicaron, solo crecen (misma partición).
      const seqs = stateEventsOf(fleet).map((seen) => BigInt(seen.event.state.seq));
      expect(seqs).toEqual([...seqs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    },
    120_000,
  );
});
