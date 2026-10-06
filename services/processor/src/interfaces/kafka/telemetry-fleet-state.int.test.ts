import { randomUUID } from "node:crypto";
import {
  alertEventSchema,
  vehicleStateEventSchema,
  type AlertEvent,
  type TelemetryRawEvent,
  type VehicleStateEvent,
} from "@fleet/contracts";
import {
  createAdmin,
  createConsumer,
  createKafka,
  createLogger,
  createPool,
  createProducer,
  databaseAdminConfig,
  defaultMigrationsDir,
  getCorrelationId,
  kafkaConfig,
  loadConfig,
  migrate,
  withCorrelationId,
} from "@fleet/platform";
import { createTempDatabase, createTempTopic, type TempDatabase, type TempTopic } from "@fleet/platform/testing";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createPersistTelemetryBatch } from "../../application/persist-telemetry-batch.js";
import type { FleetEventPublisher } from "../../application/ports.js";
import { createUpdateFleetState } from "../../application/update-fleet-state.js";
import { DEFAULT_FLEET_RULES } from "../../domain/vehicle-state.js";
import { createKafkaDeadLetterPublisher } from "../../infrastructure/kafka-dead-letter-publisher.js";
import { createKafkaFleetEventPublisher } from "../../infrastructure/kafka-fleet-event-publisher.js";
import { createPgFleetStateUnitOfWork } from "../../infrastructure/pg-fleet-state-store.js";
import { createPgTelemetryRepository } from "../../infrastructure/pg-telemetry-repository.js";
import { createAlertIdGenerator } from "../../infrastructure/uuid-v5-alert-ids.js";
import { createTelemetryBatchHandler } from "./telemetry-batch-handler.js";
import { createTelemetryConsumerRunner } from "./telemetry-consumer.js";

// Contra Redpanda y TimescaleDB reales, con TODA la cadena de producción (consumer, caso de uso de persistencia, estado de la flota,
// adaptadores SQL y publicadores de Kafka) sobre tópicos temporales y una base temporal. Lo único que se interpone es un decorador del
// publicador de eventos que falla cuando el test lo pide.
const config = loadConfig(z.object({ ...databaseAdminConfig.shape, ...kafkaConfig.shape }));
const logger = createLogger({ service: "processor-fleet-state-it", level: "error" });
const kafka = createKafka({ brokers: config.KAFKA_BROKERS, clientId: "processor-fleet-state-it", logger });
const rolePasswords = { fleet_app: config.FLEET_APP_PASSWORD, fleet_ro: config.FLEET_RO_PASSWORD };

const admin = createAdmin(kafka);
let db: TempDatabase;
let pool: Pool;

beforeAll(async () => {
  db = await createTempDatabase(config.DATABASE_ADMIN_URL);
  await migrate({ adminUrl: db.adminUrl, migrationsDir: defaultMigrationsDir, rolePasswords, logger });
  pool = createPool({ connectionString: db.urlFor("fleet_app", rolePasswords.fleet_app), applicationName: "processor-fleet-state-it", logger, max: 6 });
  await admin.connect();
});

afterAll(async () => {
  await admin.disconnect().catch(() => undefined);
  await pool?.end();
  await db?.drop();
});

const MINUTE = 60_000;
const BASE_MS = Math.floor(Date.now() / 1_000) * 1_000 - 2 * 3_600_000;
const at = (minutes: number) => new Date(BASE_MS + minutes * MINUTE).toISOString();
const RECTANGLE = "POLYGON((-75.57 6.25, -75.56 6.25, -75.56 6.26, -75.57 6.26, -75.57 6.25))";
const INSIDE = { lon: -75.565, lat: 6.255 };

interface Scope {
  tenantId: string;
  vehicleId: string;
  deviceId: string;
  zoneId: string;
}

/** Tenant, vehículo y una zona CRÍTICA que contiene `INSIDE`. */
async function seedScope(): Promise<Scope> {
  const scope: Scope = { tenantId: randomUUID(), vehicleId: randomUUID(), deviceId: randomUUID(), zoneId: randomUUID() };
  await pool.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [scope.tenantId, `it-fleet-${scope.tenantId.slice(0, 8)}`]);
  await pool.query("INSERT INTO vehicles (id, tenant_id, plate) VALUES ($1, $2, $3)", [scope.vehicleId, scope.tenantId, `P${scope.vehicleId.slice(0, 5).toUpperCase()}`]);
  await pool.query("INSERT INTO zones (zone_id, tenant_id, name, kind, geom) VALUES ($1, $2, 'Zona crítica', 'critical', ST_GeomFromText($3, 4326))", [
    scope.zoneId,
    scope.tenantId,
    RECTANGLE,
  ]);
  return scope;
}

const eventOf = (scope: Scope, minutes: number, speedMps: number, eventId = randomUUID()): TelemetryRawEvent => ({
  schemaVersion: 1,
  tenantId: scope.tenantId,
  deviceId: scope.deviceId,
  receivedAt: at(minutes + 1),
  point: {
    eventId,
    vehicleId: scope.vehicleId,
    recordedAt: at(minutes),
    lon: INSIDE.lon,
    lat: INSIDE.lat,
    speedMps,
    headingDeg: null,
    accuracyM: 5,
    mocked: false,
    lowAccuracy: false,
  },
});

async function waitFor<T>(what: string, probe: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 25_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await probe();
    if (result !== undefined && result !== false) return result;
    if (Date.now() > deadline) throw new Error(`Se agotaron ${timeoutMs} ms esperando: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

interface Seen<T> {
  key: string | undefined;
  correlationId: string | undefined;
  event: T;
}

interface Pipeline {
  scope: Scope;
  /** Cuántas publicaciones de eventos fallan antes de que el publicador se recupere. */
  failPublishes: number;
  publishCalls: number;
  states: Seen<VehicleStateEvent>[];
  alerts: Seen<AlertEvent>[];
  send(events: TelemetryRawEvent[], correlationId: string): Promise<void>;
  committedOffset(): Promise<string>;
  /** Fin (offset siguiente al último) de los tópicos de eventos: lo ya confirmado por el broker. */
  eventsHighWatermark(): Promise<{ states: number; alerts: number }>;
}

async function withPipeline(run: (pipeline: Pipeline) => Promise<void>): Promise<void> {
  const rawTopic: TempTopic = await createTempTopic(admin, 1);
  const dlqTopic: TempTopic = await createTempTopic(admin, 1);
  const stateTopic: TempTopic = await createTempTopic(admin, 1);
  const alertsTopic: TempTopic = await createTempTopic(admin, 1);
  const producer = createProducer(kafka, { retry: { retries: 1, initialRetryTime: 50, maxRetryTime: 200 } });
  const groupId = `processor-fleet-it-${randomUUID().slice(0, 8)}`;
  const readerGroups = [`processor-fleet-it-s-${randomUUID().slice(0, 8)}`, `processor-fleet-it-a-${randomUUID().slice(0, 8)}`];
  const scope = await seedScope();

  const pipeline: Pipeline = {
    scope,
    failPublishes: 0,
    publishCalls: 0,
    states: [],
    alerts: [],
    send: async (events, correlationId) => {
      await producer.send({
        topic: rawTopic.name,
        messages: events.map((event) => ({ key: scope.vehicleId, value: JSON.stringify(event), headers: withCorrelationId(undefined, correlationId) })),
      });
    },
    committedOffset: async () => {
      const [topic] = await admin.fetchOffsets({ groupId, topics: [rawTopic.name] });
      return topic?.partitions.find((partition) => partition.partition === 0)?.offset ?? "-1";
    },
    eventsHighWatermark: async () => {
      const [states, alerts] = await Promise.all([admin.fetchTopicOffsets(stateTopic.name), admin.fetchTopicOffsets(alertsTopic.name)]);
      return { states: Number(states[0]?.high ?? 0), alerts: Number(alerts[0]?.high ?? 0) };
    },
  };

  const realPublisher = createKafkaFleetEventPublisher({
    producer,
    timeoutMs: 10_000,
    topics: { vehicleState: stateTopic.name, fleetAlerts: alertsTopic.name },
  });
  const publisher: FleetEventPublisher = {
    publish: (events) => {
      pipeline.publishCalls += 1;
      if (pipeline.failPublishes > 0) {
        pipeline.failPublishes -= 1;
        return Promise.reject(new Error("el broker no confirmó (simulado)"));
      }
      return realPublisher.publish(events);
    },
  };
  const fleetState = createUpdateFleetState({
    unitOfWork: createPgFleetStateUnitOfWork(pool),
    publisher,
    alertIds: createAlertIdGenerator(),
    clock: { now: () => new Date() },
    logger,
    rules: DEFAULT_FLEET_RULES,
  });
  const persist = createPersistTelemetryBatch({
    repository: createPgTelemetryRepository(pool),
    fleetState,
    deadLetters: createKafkaDeadLetterPublisher({ producer, timeoutMs: 10_000, topic: dlqTopic.name }),
    clock: { now: () => new Date() },
    sleeper: { sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
    random: { next: () => Math.random() },
    logger,
    maxAttempts: 2,
    backoff: { initialDelayMs: 10, maxDelayMs: 20 },
    chunkSize: 100,
    heartbeatIntervalMs: 3_000,
  });
  // `retry`: tras un error del handler kafkajs reinicia el consumer; con un reinicio rápido el test no espera segundos.
  const consumer = createConsumer(kafka, { groupId, retry: { initialRetryTime: 100, maxRetryTime: 300, retries: 10 } });
  const fatal: string[] = [];
  const runner = createTelemetryConsumerRunner({ consumer, topic: rawTopic.name, groupId, handler: createTelemetryBatchHandler(persist), logger, onFatal: (reason) => fatal.push(reason) });

  const readers = [createConsumer(kafka, { groupId: readerGroups[0] ?? "" }), createConsumer(kafka, { groupId: readerGroups[1] ?? "" })];
  try {
    await producer.connect();
    await Promise.all(readers.map((reader) => reader.connect()));
    await readers[0]?.subscribe({ topic: stateTopic.name, fromBeginning: true });
    await readers[1]?.subscribe({ topic: alertsTopic.name, fromBeginning: true });
    await readers[0]?.run({
      eachMessage: ({ message }) => {
        pipeline.states.push({
          key: message.key?.toString(),
          correlationId: getCorrelationId(message.headers),
          event: vehicleStateEventSchema.parse(JSON.parse(message.value?.toString() ?? "null")),
        });
        return Promise.resolve();
      },
    });
    await readers[1]?.run({
      eachMessage: ({ message }) => {
        pipeline.alerts.push({
          key: message.key?.toString(),
          correlationId: getCorrelationId(message.headers),
          event: alertEventSchema.parse(JSON.parse(message.value?.toString() ?? "null")),
        });
        return Promise.resolve();
      },
    });
    await runner.start();
    await run(pipeline);
    expect(fatal).toEqual([]);
  } finally {
    await runner.stop().catch(() => undefined);
    await Promise.all(readers.map((reader) => reader.disconnect().catch(() => undefined)));
    await producer.disconnect().catch(() => undefined);
    await Promise.all([
      admin.deleteGroups([groupId, ...readerGroups]).catch(() => undefined),
      ...[rawTopic, dlqTopic, stateTopic, alertsTopic].map((topic) => topic.drop().catch(() => undefined)),
    ]);
  }
}

const TEST_TIMEOUT = 90_000;
/** Detenido 25 minutos en la zona crítica (puntos cada 5 min con velocidad 0). */
const stopFor25Minutes = (scope: Scope) => [0, 5, 10, 15, 20, 25].map((minutes) => eventOf(scope, minutes, 0));

describe("telemetry.raw -> vehicle_state, alerts, vehicle.state y fleet.alerts contra Redpanda y TimescaleDB", () => {
  it(
    "el estado y la alerta se escriben, se publican con key y correlationId del mensaje, y el offset solo avanza DESPUÉS de que el broker confirmó los eventos",
    async () => {
      await withPipeline(async (pipeline) => {
        const { scope } = pipeline;
        await pipeline.send(stopFor25Minutes(scope), "it-fleet-1");

        await waitFor("los 6 mensajes confirmados (offset 6)", async () => (await pipeline.committedOffset()) === "6");
        // Regla 6: con el offset ya confirmado, los eventos YA estaban confirmados por el broker (high watermark), no en camino.
        const high = await pipeline.eventsHighWatermark();
        expect(high.states).toBeGreaterThanOrEqual(1);
        expect(high.alerts).toBeGreaterThanOrEqual(1);

        await waitFor("el estado y la alerta en los tópicos", () => pipeline.states.length > 0 && pipeline.alerts.length > 0);
        const lastState = pipeline.states.at(-1);
        expect(lastState).toMatchObject({
          key: scope.vehicleId,
          correlationId: "it-fleet-1",
          event: { schemaVersion: 1, tenantId: scope.tenantId, state: { vehicleId: scope.vehicleId, movement: "stopped", stoppedSince: at(0), zoneIds: [scope.zoneId] } },
        });
        expect(pipeline.alerts[0]).toMatchObject({
          key: scope.vehicleId,
          correlationId: "it-fleet-1",
          event: { tenantId: scope.tenantId, alert: { type: "critical_zone_stop", zoneId: scope.zoneId, zoneName: "Zona crítica", startedAt: at(0), resolvedAt: null } },
        });
        // La base coincide con lo publicado.
        const { rows } = await pool.query<{ movement: string; stopped_since: Date; seq: string }>(
          "SELECT movement, stopped_since, seq::text AS seq FROM vehicle_state WHERE tenant_id = $1 AND vehicle_id = $2",
          [scope.tenantId, scope.vehicleId],
        );
        expect(rows[0]?.movement).toBe("stopped");
        expect(rows[0]?.stopped_since.toISOString()).toBe(at(0));
        expect(rows[0]?.seq).toBe(lastState?.event.state.seq);
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "idempotencia: el mismo mensaje dos veces deja un solo estado y una sola alerta; el estado republicado conserva su seq",
    async () => {
      await withPipeline(async (pipeline) => {
        const { scope } = pipeline;
        const points = stopFor25Minutes(scope);
        await pipeline.send(points, "it-idem-1");
        await waitFor("los 6 mensajes confirmados", async () => (await pipeline.committedOffset()) === "6");
        const seqAfterFirst = (await pool.query<{ seq: string }>("SELECT seq::text AS seq FROM vehicle_state WHERE vehicle_id = $1", [scope.vehicleId])).rows[0]?.seq;

        await pipeline.send(points, "it-idem-2");
        await waitFor("los 12 mensajes confirmados", async () => (await pipeline.committedOffset()) === "12");

        const { rows: alertCount } = await pool.query<{ n: string }>("SELECT count(*) AS n FROM alerts WHERE vehicle_id = $1", [scope.vehicleId]);
        expect(alertCount[0]?.n).toBe("1");
        const { rows: stateCount } = await pool.query<{ n: string; seq: string }>("SELECT count(*) AS n, max(seq)::text AS seq FROM vehicle_state WHERE vehicle_id = $1", [scope.vehicleId]);
        expect(stateCount[0]).toEqual({ n: "1", seq: seqAfterFirst });
        // La reentrega republicó el estado vigente: el mismo seq, para que el consumidor lo descarte.
        await waitFor("el estado republicado", () => pipeline.states.filter((seen) => seen.correlationId === "it-idem-2").length > 0);
        expect(new Set(pipeline.states.map((seen) => seen.event.state.seq))).toEqual(new Set([seqAfterFirst]));
        const alertIds = new Set(pipeline.alerts.map((seen) => seen.event.alert.alertId));
        expect(alertIds.size).toBe(1);
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "si la publicación falla, el offset NO avanza; al recuperarse, la reentrega republica el estado y la alerta que ya estaban en la base (nada se pierde)",
    async () => {
      await withPipeline(async (pipeline) => {
        const { scope } = pipeline;
        pipeline.failPublishes = 1;

        await pipeline.send(stopFor25Minutes(scope), "it-fail-1");

        // La primera entrega escribió el estado y la alerta y falló al publicar: con el offset sin confirmar.
        await waitFor("la primera publicación (fallida)", () => pipeline.publishCalls >= 1);
        // La segunda entrega publica de verdad y entonces sí se confirma el offset.
        await waitFor("los 6 mensajes confirmados tras recuperarse", async () => (await pipeline.committedOffset()) === "6");
        expect(pipeline.publishCalls).toBeGreaterThanOrEqual(2);
        const high = await pipeline.eventsHighWatermark();
        expect(high.states).toBeGreaterThanOrEqual(1);
        expect(high.alerts).toBeGreaterThanOrEqual(1);

        await waitFor("estado y alerta republicados", () => pipeline.states.length > 0 && pipeline.alerts.length > 0);
        expect(pipeline.alerts[0]?.event.alert).toMatchObject({ type: "critical_zone_stop", resolvedAt: null });
        const { rows } = await pool.query<{ n: string }>("SELECT count(*) AS n FROM alerts WHERE vehicle_id = $1", [scope.vehicleId]);
        expect(rows[0]?.n).toBe("1");
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "moverse resuelve la alerta: se publica la resolución con la misma alertId y un seq mayor, y el estado vuelve a moving",
    async () => {
      await withPipeline(async (pipeline) => {
        const { scope } = pipeline;
        await pipeline.send(stopFor25Minutes(scope), "it-move-1");
        await waitFor("los 6 mensajes confirmados", async () => (await pipeline.committedOffset()) === "6");
        await waitFor("la alerta levantada", () => pipeline.alerts.length > 0);
        const raised = pipeline.alerts[0]?.event.alert;

        await pipeline.send([eventOf(scope, 30, 10)], "it-move-2");
        await waitFor("el mensaje en movimiento confirmado", async () => (await pipeline.committedOffset()) === "7");

        const resolved = await waitFor("la resolución en fleet.alerts", () => pipeline.alerts.find((seen) => seen.event.alert.resolvedAt !== null));
        expect(resolved.event.alert).toMatchObject({ alertId: raised?.alertId, resolvedAt: at(30) });
        expect(BigInt(resolved.event.alert.seq)).toBeGreaterThan(BigInt(raised?.seq ?? "0"));
        const lastState = await waitFor("el estado en movimiento", () => pipeline.states.find((seen) => seen.event.state.movement === "moving"));
        expect(lastState.event.state).toMatchObject({ stoppedSince: null, recordedAt: at(30) });
      });
    },
    TEST_TIMEOUT,
  );
});
