import { randomUUID } from "node:crypto";
import { telemetryDlqMessageSchema, type TelemetryDlqMessage, type TelemetryRawEvent } from "@fleet/contracts";
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
import type { TelemetryRepository } from "../../application/ports.js";
import { createKafkaDeadLetterPublisher } from "../../infrastructure/kafka-dead-letter-publisher.js";
import { createPgTelemetryRepository } from "../../infrastructure/pg-telemetry-repository.js";
import { createTelemetryBatchHandler } from "./telemetry-batch-handler.js";
import { createTelemetryConsumerRunner } from "./telemetry-consumer.js";

// Contra Redpanda y TimescaleDB reales: tópicos y grupo temporales (nunca los reales), una base temporal con las
// migraciones reales y TODA la cadena de producción (runner, handler, caso de uso, adaptador SQL y publicador de la DLQ).
// Lo único que se interpone es un decorador del repositorio que simula una caída de la base cuando el test lo pide.
const config = loadConfig(z.object({ ...databaseAdminConfig.shape, ...kafkaConfig.shape }));
const logger = createLogger({ service: "processor-consumer-it", level: "error" });
const kafka = createKafka({ brokers: config.KAFKA_BROKERS, clientId: "processor-consumer-it", logger });
const rolePasswords = { fleet_app: config.FLEET_APP_PASSWORD, fleet_ro: config.FLEET_RO_PASSWORD };

const admin = createAdmin(kafka);
let db: TempDatabase;
let pool: Pool;

beforeAll(async () => {
  db = await createTempDatabase(config.DATABASE_ADMIN_URL);
  await migrate({ adminUrl: db.adminUrl, migrationsDir: defaultMigrationsDir, rolePasswords, logger });
  pool = createPool({ connectionString: db.urlFor("fleet_app", rolePasswords.fleet_app), applicationName: "processor-consumer-it", logger, max: 4 });
  await admin.connect();
});

afterAll(async () => {
  await admin.disconnect();
  await pool?.end();
  await db?.drop();
});

const HOUR_MS = 3_600_000;
const BASE_MS = Math.floor(Date.now() / 1_000) * 1_000 - HOUR_MS;
// Una fila válida para el dominio que Postgres rechaza con 23514 (CHECK) por una restricción que el test agrega a la base
// temporal: una fila venenosa real. (El año 0000 ya no sirve: el processor lo rechaza antes como stale_timestamp.)
const POISON_SPEED_MPS = 77.77;

interface Scope {
  tenantId: string;
  vehicleId: string;
  deviceId: string;
}
const newScope = (): Scope => ({ tenantId: randomUUID(), vehicleId: randomUUID(), deviceId: randomUUID() });

function eventOf(scope: Scope, index: number, pointOverrides: Partial<TelemetryRawEvent["point"]> = {}): TelemetryRawEvent {
  return {
    schemaVersion: 1,
    tenantId: scope.tenantId,
    deviceId: scope.deviceId,
    receivedAt: new Date(BASE_MS + 5_000).toISOString(),
    point: {
      eventId: randomUUID(),
      vehicleId: scope.vehicleId,
      recordedAt: new Date(BASE_MS + index * 1_000).toISOString(),
      lon: -75.5636,
      lat: 6.2518,
      speedMps: 12.5,
      headingDeg: 90,
      accuracyM: 8,
      mocked: false,
      lowAccuracy: false,
      ...pointOverrides,
    },
  };
}

const connectionError = () => Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });

/** Espera por sondeo, nunca con un sleep fijo. */
async function waitFor<T>(what: string, probe: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 25_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await probe();
    if (result !== undefined && result !== false) return result;
    if (Date.now() > deadline) throw new Error(`Se agotaron ${timeoutMs} ms esperando: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

interface DlqSeen {
  key: string | undefined;
  correlationId: string | undefined;
  message: TelemetryDlqMessage;
}

interface Pipeline {
  rawTopic: string;
  groupId: string;
  /** Mientras sea `true`, el repositorio falla como una base caída (transitorio). */
  failing: boolean;
  /** Si no está vacío, solo falla (transitorio) el lote que contiene alguno de estos eventId. */
  failOnlyFor: Set<string>;
  /** Cuántas veces se llamó al repositorio. */
  insertCalls: number;
  /** Si no es `undefined`, el repositorio espera a que se resuelva antes de insertar un lote que contenga `gateEventId`. */
  gate: Promise<void> | undefined;
  gateEventId: string | undefined;
  /** Motivos con los que el runner pidió apagar el proceso (consumer caído sin reinicio). Debe quedar vacío. */
  fatal: string[];
  dlq: DlqSeen[];
  send(messages: { key: string; value: string; correlationId: string }[]): Promise<void>;
  /** Offset confirmado del grupo en la partición 0 (el siguiente a leer), o `-1` si no hay commit. */
  committedOffset(): Promise<string>;
  countRows(scope: Scope): Promise<number>;
}

/**
 * `restartBackoffMs`: espera de kafkajs antes de reentregar tras un error del handler (por defecto 100-300 ms). Un test que debe cambiar la
 * base ENTRE dos entregas la sube para tener una ventana holgada y no depender de milisegundos.
 */
async function withPipeline(options: { chunkSize?: number; restartBackoffMs?: number }, run: (pipeline: Pipeline) => Promise<void>): Promise<void> {
  const rawTopic: TempTopic = await createTempTopic(admin, 1);
  const dlqTopic: TempTopic = await createTempTopic(admin, 1);
  // Un productor por pipeline: kafkajs recuerda los tópicos a los que escribió y los pide en cada refresco de metadatos; con
  // un productor compartido, el tópico borrado de una prueba anterior haría fallar el refresco de las siguientes.
  const producer = createProducer(kafka, { retry: { retries: 1, initialRetryTime: 50, maxRetryTime: 200 } });
  const groupId = `processor-it-${randomUUID().slice(0, 8)}`;
  const dlqGroupId = `processor-it-dlq-${randomUUID().slice(0, 8)}`;

  const pipeline: Pipeline = {
    rawTopic: rawTopic.name,
    groupId,
    failing: false,
    failOnlyFor: new Set(),
    insertCalls: 0,
    gate: undefined,
    gateEventId: undefined,
    fatal: [],
    dlq: [],
    send: async (messages) => {
      await producer.send({
        topic: rawTopic.name,
        messages: messages.map(({ key, value, correlationId }) => ({ key, value, headers: withCorrelationId(undefined, correlationId) })),
      });
    },
    committedOffset: async () => {
      const [topic] = await admin.fetchOffsets({ groupId, topics: [rawTopic.name] });
      return topic?.partitions.find((partition) => partition.partition === 0)?.offset ?? "-1";
    },
    countRows: async (scope) => {
      const { rows } = await pool.query<{ n: string }>(
        "SELECT count(*) AS n FROM telemetry WHERE tenant_id = $1 AND vehicle_id = $2 AND recorded_at >= $3 AND recorded_at < $4",
        [scope.tenantId, scope.vehicleId, new Date(BASE_MS - 24 * HOUR_MS), new Date(BASE_MS + 24 * HOUR_MS)],
      );
      return Number(rows[0]?.n);
    },
  };

  const real = createPgTelemetryRepository(pool);
  const repository: TelemetryRepository = {
    insertBatch: async (events) => {
      pipeline.insertCalls += 1;
      if (pipeline.gate !== undefined && events.some((event) => event.point.eventId === pipeline.gateEventId)) await pipeline.gate;
      const hit = pipeline.failOnlyFor.size === 0 || events.some((event) => pipeline.failOnlyFor.has(event.point.eventId));
      if (pipeline.failing && hit) throw connectionError();
      return real.insertBatch(events);
    },
  };
  const persist = createPersistTelemetryBatch({
    repository,
    deadLetters: createKafkaDeadLetterPublisher({ producer, timeoutMs: 10_000, topic: dlqTopic.name }),
    clock: { now: () => new Date() },
    sleeper: { sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
    random: { next: () => Math.random() },
    logger,
    maxAttempts: 2,
    backoff: { initialDelayMs: 10, maxDelayMs: 20 },
    chunkSize: options.chunkSize ?? 100,
    heartbeatIntervalMs: 3_000,
  });
  // `retry`: tras un error del handler kafkajs reinicia el consumer; con un reinicio rápido el test no espera segundos.
  const consumer = createConsumer(kafka, {
    groupId,
    retry: { initialRetryTime: options.restartBackoffMs ?? 100, maxRetryTime: options.restartBackoffMs ?? 300, retries: 10 },
  });
  const runner = createTelemetryConsumerRunner({ consumer, topic: rawTopic.name, groupId, handler: createTelemetryBatchHandler(persist),
    logger,
    onFatal: (reason) => pipeline.fatal.push(reason),
  });

  const dlqConsumer = createConsumer(kafka, { groupId: dlqGroupId });
  try {
    await producer.connect();
    await dlqConsumer.connect();
    await dlqConsumer.subscribe({ topic: dlqTopic.name, fromBeginning: true });
    await dlqConsumer.run({
      eachMessage: ({ message }) => {
        pipeline.dlq.push({
          key: message.key?.toString(),
          correlationId: getCorrelationId(message.headers),
          message: telemetryDlqMessageSchema.parse(JSON.parse(message.value?.toString() ?? "null")),
        });
        return Promise.resolve();
      },
    });
    await runner.start();
    await run(pipeline);
  } finally {
    await runner.stop().catch(() => undefined);
    await dlqConsumer.disconnect().catch(() => undefined);
    await producer.disconnect().catch(() => undefined);
    await Promise.all([admin.deleteGroups([groupId, dlqGroupId]).catch(() => undefined), rawTopic.drop().catch(() => undefined), dlqTopic.drop().catch(() => undefined)]);
  }
}

const TEST_TIMEOUT = 60_000;

describe("consumer de telemetry.raw contra Redpanda y TimescaleDB", () => {
  it(
    "idempotencia: el mismo mensaje dos veces deja UNA fila y el offset se confirma después de persistir",
    async () => {
      await withPipeline({}, async (pipeline) => {
        const scope = newScope();
        const event = eventOf(scope, 0);
        const value = JSON.stringify(event);

        await pipeline.send([
          { key: scope.vehicleId, value, correlationId: "it-dup-1" },
          { key: scope.vehicleId, value, correlationId: "it-dup-2" },
        ]);

        await waitFor("los dos mensajes confirmados (offset 2)", async () => (await pipeline.committedOffset()) === "2");
        expect(await pipeline.countRows(scope)).toBe(1);
        expect(pipeline.dlq).toEqual([]);

        // Reentrega explícita del mismo mensaje más tarde: sigue siendo una sola fila.
        await pipeline.send([{ key: scope.vehicleId, value, correlationId: "it-dup-3" }]);
        await waitFor("el tercer mensaje confirmado (offset 3)", async () => (await pipeline.committedOffset()) === "3");
        expect(await pipeline.countRows(scope)).toBe(1);
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "mensaje inválido: va a la DLQ (processor, invalid_schema) con el string original, key y correlationId, y no frena a los válidos",
    async () => {
      await withPipeline({}, async (pipeline) => {
        const scope = newScope();
        const valid = eventOf(scope, 1);

        await pipeline.send([
          { key: scope.vehicleId, value: "{no es json", correlationId: "it-invalid" },
          { key: scope.vehicleId, value: JSON.stringify(valid), correlationId: "it-valid" },
        ]);

        const seen = await waitFor("el mensaje inválido en la DLQ", () => pipeline.dlq[0]);
        await waitFor("los dos mensajes confirmados (offset 2)", async () => (await pipeline.committedOffset()) === "2");
        expect(pipeline.dlq).toHaveLength(1);
        expect(seen.key).toBe(scope.vehicleId);
        expect(seen.correlationId).toBe("it-invalid");
        expect(seen.message).toMatchObject({
          schemaVersion: 1,
          source: "processor",
          reason: { code: "invalid_schema" },
          tenantId: null,
          vehicleId: null,
          eventId: null,
          attempts: 0,
          originalPayload: "{no es json",
        });
        expect(await pipeline.countRows(scope)).toBe(1);
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "punto fuera de Colombia: a la DLQ como outside_operating_area con sus ids y el payload original, y no se inserta",
    async () => {
      await withPipeline({}, async (pipeline) => {
        const scope = newScope();
        const madrid = eventOf(scope, 2, { lon: -3.7038, lat: 40.4168 });

        await pipeline.send([{ key: scope.vehicleId, value: JSON.stringify(madrid), correlationId: "it-madrid" }]);

        const seen = await waitFor("el punto de Madrid en la DLQ", () => pipeline.dlq[0]);
        await waitFor("el mensaje confirmado (offset 1)", async () => (await pipeline.committedOffset()) === "1");
        expect(seen.key).toBe(scope.vehicleId);
        expect(seen.correlationId).toBe("it-madrid");
        expect(seen.message).toMatchObject({
          source: "processor",
          reason: { code: "outside_operating_area" },
          tenantId: scope.tenantId,
          deviceId: scope.deviceId,
          vehicleId: scope.vehicleId,
          eventId: madrid.point.eventId,
          attempts: 0,
          originalPayload: madrid,
        });
        expect(await pipeline.countRows(scope)).toBe(0);
      });
    },
    TEST_TIMEOUT,
  );

  // Regresión del hallazgo M-a: la DLQ del tramo se publicaba en UN solo sendBatch. Con un tramo grande de rechazos (un dispositivo con
  // lon y lat intercambiadas) superaba el 1 MiB de Redpanda: MESSAGE_TOO_LARGE, reentrega sin fin y la partición detenida.
  it(
    "1500 mensajes fuera de área en un solo tramo: la DLQ se publica en sub-lotes (> 1 MiB en total), todos llegan y el offset se confirma",
    async () => {
      await withPipeline({ chunkSize: 1_500 }, async (pipeline) => {
        const scope = newScope();
        // Lon y lat intercambiadas: la latitud 6.25 como longitud y viceversa cae fuera de Colombia.
        const swapped = Array.from({ length: 1_500 }, (_, i) => eventOf(scope, i, { lon: 6.2518, lat: -75.5636 }));

        await pipeline.send(swapped.map((event, i) => ({ key: scope.vehicleId, value: JSON.stringify(event), correlationId: `it-big-${i}` })));

        await waitFor("los 1500 mensajes en la DLQ", () => (pipeline.dlq.length === 1_500 ? true : undefined), 50_000);
        await waitFor("los 1500 confirmados (offset 1500)", async () => (await pipeline.committedOffset()) === "1500", 50_000);
        const dlqBytes = pipeline.dlq.reduce((total, seen) => total + Buffer.byteLength(JSON.stringify(seen.message)), 0);
        // Sin esto el test no probaría nada: tiene que superar lo que cabe en un solo record batch del broker.
        expect(dlqBytes).toBeGreaterThan(1_048_576);
        expect(new Set(pipeline.dlq.map((seen) => seen.message.eventId)).size).toBe(1_500);
        expect(pipeline.dlq.every((seen) => seen.message.reason.code === "outside_operating_area")).toBe(true);
        expect(await pipeline.countRows(scope)).toBe(0);
      });
    },
    120_000,
  );

  // Hallazgo M-b: una schemaVersion mayor que la conocida no va a la DLQ (no es contenido roto): detiene la partición en ese tramo.
  it(
    "schemaVersion mayor que la conocida: no va a la DLQ, lo anterior se confirma y la partición queda detenida en ese mensaje",
    async () => {
      await withPipeline({ chunkSize: 1 }, async (pipeline) => {
        const scope = newScope();
        const before = eventOf(scope, 0);
        const future = { ...eventOf(scope, 1), schemaVersion: 2 };
        const after = eventOf(scope, 2);

        await pipeline.send(
          [before, future, after].map((event, i) => ({ key: scope.vehicleId, value: JSON.stringify(event), correlationId: `it-future-${i}` })),
        );

        await waitFor("el mensaje anterior persistido y confirmado (offset 1)", async () => (await pipeline.committedOffset()) === "1");
        // Ventana negativa a propósito (no hay evento que esperar): la partición sigue detenida y nada se perdió ni se publicó.
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        expect(await pipeline.committedOffset()).toBe("1");
        expect(await pipeline.countRows(scope)).toBe(1);
        expect(pipeline.dlq).toEqual([]);
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "fila venenosa real (Postgres la rechaza): se aísla, va a la DLQ como processing_failed y las demás filas se persisten",
    async () => {
      const adminPool = createPool({ connectionString: db.adminUrl, applicationName: "processor-consumer-it-admin", logger, max: 1 });
      try {
        await adminPool.query("ALTER TABLE telemetry ADD CONSTRAINT telemetry_it_poison_speed CHECK (speed_mps IS DISTINCT FROM 77.77)");
      } finally {
        await adminPool.end();
      }
      await withPipeline({}, async (pipeline) => {
        const scope = newScope();
        const good1 = eventOf(scope, 3);
        const poison = eventOf(scope, 4, { speedMps: POISON_SPEED_MPS });
        const good2 = eventOf(scope, 5);

        await pipeline.send(
          [good1, poison, good2].map((event, i) => ({ key: scope.vehicleId, value: JSON.stringify(event), correlationId: `it-poison-${i}` })),
        );

        const seen = await waitFor("la fila venenosa en la DLQ", () => pipeline.dlq[0]);
        await waitFor("los tres mensajes confirmados (offset 3)", async () => (await pipeline.committedOffset()) === "3");
        expect(pipeline.dlq).toHaveLength(1);
        expect(seen.correlationId).toBe("it-poison-1");
        expect(seen.message).toMatchObject({
          source: "processor",
          reason: { code: "processing_failed" },
          eventId: poison.point.eventId,
          tenantId: scope.tenantId,
          attempts: 1,
          originalPayload: poison,
        });
        // El mensaje de la razón nombra un código, no el contenido del error de la base.
        expect(seen.message.reason.message).toBe("Falló la persistencia (código 23514).");
        expect(await pipeline.countRows(scope)).toBe(2);
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "el offset NO se confirma mientras la persistencia falla (nada va a la DLQ) y sí cuando la base se recupera",
    async () => {
      await withPipeline({}, async (pipeline) => {
        const scope = newScope();
        pipeline.failing = true;

        await pipeline.send([0, 1].map((i) => ({ key: scope.vehicleId, value: JSON.stringify(eventOf(scope, i)), correlationId: `it-down-${i}` })));

        // Con maxAttempts 2, cada entrega llama dos veces a la base: más de 4 llamadas prueban al menos una reentrega.
        await waitFor("al menos una reentrega del lote (kafkajs reintenta)", () => pipeline.insertCalls > 4);
        expect(await pipeline.committedOffset()).toBe("-1");
        expect(await pipeline.countRows(scope)).toBe(0);
        // Una caída de la base no es un mensaje malo: no va a la DLQ.
        expect(pipeline.dlq).toEqual([]);

        pipeline.failing = false;

        await waitFor("las dos filas persistidas", async () => (await pipeline.countRows(scope)) === 2);
        await waitFor("el offset confirmado (2) tras recuperarse la base", async () => (await pipeline.committedOffset()) === "2");
        expect(pipeline.dlq).toEqual([]);
      });
    },
    TEST_TIMEOUT,
  );

  // Regresión del hallazgo crítico: todo fallo que no es atribuible a la fila (aquí 42501, un permiso mal desplegado) se
  // clasificaba como permanente, iba a la DLQ y el offset se confirmaba: el backlog se perdía con el móvil ya habiendo borrado
  // los puntos tras el 202. Con la clasificación en cerrado, el offset queda sin confirmar y la DLQ vacía.
  // Aquí solo protege la CLASIFICACIÓN: 42501 es transitorio, así que se reintenta sin aislar fila por fila y la guarda "fallan todas
  // las filas aisladas" nunca corre. Esa guarda se ejercita con un error permanente real en el test siguiente.
  it.each([1, 3])(
    "REVOKE INSERT (42501) con %i mensaje(s): el offset NO se confirma y la DLQ queda vacía; tras el GRANT las filas se persisten y el offset se confirma",
    async (count) => {
      const adminPool = createPool({ connectionString: db.adminUrl, applicationName: "processor-consumer-it-admin", logger, max: 1 });
      try {
        await withPipeline({}, async (pipeline) => {
          const scope = newScope();
          await adminPool.query("REVOKE INSERT ON telemetry FROM fleet_app");
          try {
            await pipeline.send(Array.from({ length: count }, (_, i) => ({ key: scope.vehicleId, value: JSON.stringify(eventOf(scope, i)), correlationId: `it-revoke-${i}` })));

            // Con maxAttempts 2, cada entrega llama dos veces a la base: más de 4 llamadas prueban al menos una reentrega.
            await waitFor("al menos una reentrega del lote (kafkajs reintenta)", () => pipeline.insertCalls > 4);
            expect(await pipeline.committedOffset()).toBe("-1");
            expect(await pipeline.countRows(scope)).toBe(0);
            expect(pipeline.dlq).toEqual([]);
          } finally {
            await adminPool.query("GRANT INSERT ON telemetry TO fleet_app");
          }

          await waitFor("las filas persistidas tras el GRANT", async () => (await pipeline.countRows(scope)) === count);
          await waitFor("el offset confirmado tras el GRANT", async () => (await pipeline.committedOffset()) === String(count));
          expect(pipeline.dlq).toEqual([]);
          expect(pipeline.fatal).toEqual([]);
        });
      } finally {
        // Si el test falló antes del GRANT, la base temporal se descarta igual; esto solo evita dejarla sin permiso mientras tanto.
        await adminPool.query("GRANT INSERT ON telemetry TO fleet_app").catch(() => undefined);
        await adminPool.end();
      }
    },
    TEST_TIMEOUT,
  );

  // La guarda "fallan TODAS las filas aisladas": un error PERMANENTE real (23514, una restricción que ninguna fila cumple) hace que el
  // INSERT del tramo falle y que el aislamiento fila por fila falle en todas. No hay una fila venenosa sino un problema de la base:
  // el tramo NO va a la DLQ ni se confirma. Al quitar la restricción, las filas se persisten y el offset avanza.
  it(
    "error permanente en TODAS las filas (CHECK que ninguna cumple): el offset NO se confirma y la DLQ queda vacía; al quitar la restricción se persisten y se confirma",
    async () => {
      const adminPool = createPool({ connectionString: db.adminUrl, applicationName: "processor-consumer-it-admin", logger, max: 1 });
      try {
        await withPipeline({ restartBackoffMs: 1_000 }, async (pipeline) => {
          const scope = newScope();
          await adminPool.query("ALTER TABLE telemetry ADD CONSTRAINT it_all_fail CHECK (speed_mps < 0) NOT VALID");
          try {
            await pipeline.send(Array.from({ length: 3 }, (_, i) => ({ key: scope.vehicleId, value: JSON.stringify(eventOf(scope, i)), correlationId: `it-allfail-${i}` })));

            // Cada entrega hace 1 insert del tramo y 3 aislados (4 llamadas, sin reintentos: el error es permanente). Con 8 o más, y justo
            // al terminar una entrega (múltiplo de 4), el aislamiento corrió y el lote se reentregó; kafkajs espera ~1 s antes de la
            // siguiente, ventana de sobra para quitar la restricción entre dos entregas (si no, una fila fallaría antes y las otras no).
            await waitFor("al menos dos entregas completas del lote, con su aislamiento fila por fila", () => pipeline.insertCalls >= 8 && pipeline.insertCalls % 4 === 0);
            expect(await pipeline.committedOffset()).toBe("-1");
            expect(await pipeline.countRows(scope)).toBe(0);
            expect(pipeline.dlq).toEqual([]);
          } finally {
            await adminPool.query("ALTER TABLE telemetry DROP CONSTRAINT IF EXISTS it_all_fail");
          }

          await waitFor("las 3 filas persistidas tras quitar la restricción", async () => (await pipeline.countRows(scope)) === 3);
          await waitFor("el offset confirmado (3) tras quitar la restricción", async () => (await pipeline.committedOffset()) === "3");
          expect(pipeline.dlq).toEqual([]);
          expect(pipeline.fatal).toEqual([]);
        });
      } finally {
        await adminPool.query("ALTER TABLE telemetry DROP CONSTRAINT IF EXISTS it_all_fail").catch(() => undefined);
        await adminPool.end();
      }
    },
    TEST_TIMEOUT,
  );

  // Con `commitOffsetsIfNecessary()` sin argumentos (kafkajs 2.2.4) nada se confirma hasta el fin del lote, así que el offset
  // del primer tramo solo avanzaba al terminar el lote entero. El segundo tramo se bloquea a propósito: el commit del primero
  // tiene que llegar mientras el lote sigue en curso.
  it(
    "commit por tramo: el offset confirmado avanza tras el primer tramo SIN esperar el fin del lote",
    async () => {
      await withPipeline({ chunkSize: 2 }, async (pipeline) => {
        const scope = newScope();
        const events = [0, 1, 2, 3, 4].map((i) => eventOf(scope, i));
        let release: () => void = () => undefined;
        pipeline.gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        pipeline.gateEventId = events[2]?.point.eventId;
        try {
          await pipeline.send(events.map((event, i) => ({ key: scope.vehicleId, value: JSON.stringify(event), correlationId: `it-commit-${i}` })));

          // El segundo tramo está detenido en el insert: el lote NO ha terminado y, aun así, el primer tramo ya está confirmado.
          await waitFor("el primer tramo confirmado (offset 2) con el lote aún en curso", async () => (await pipeline.committedOffset()) === "2");
          expect(await pipeline.countRows(scope)).toBe(2);
        } finally {
          release();
        }

        await waitFor("los cinco confirmados (offset 5)", async () => (await pipeline.committedOffset()) === "5");
        expect(await pipeline.countRows(scope)).toBe(5);
        expect(pipeline.dlq).toEqual([]);
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "lote largo por tramos: lo ya persistido se confirma aunque un tramo posterior falle, y el resto se confirma al recuperarse",
    async () => {
      await withPipeline({ chunkSize: 2 }, async (pipeline) => {
        const scope = newScope();
        const events = [0, 1, 2, 3, 4].map((i) => eventOf(scope, i));
        // Solo falla el lote que contiene al tercer evento (el segundo tramo de 2).
        pipeline.failOnlyFor.add(events[2]?.point.eventId ?? "");
        pipeline.failing = true;

        await pipeline.send(events.map((event, i) => ({ key: scope.vehicleId, value: JSON.stringify(event), correlationId: `it-chunk-${i}` })));

        await waitFor("el primer tramo persistido y confirmado (offset 2) mientras el segundo falla", async () => (await pipeline.committedOffset()) === "2");
        await waitFor("al menos una reentrega del lote", () => pipeline.insertCalls > 4);
        expect(await pipeline.committedOffset()).toBe("2");
        expect(await pipeline.countRows(scope)).toBe(2);

        pipeline.failing = false;

        await waitFor("los cinco confirmados (offset 5)", async () => (await pipeline.committedOffset()) === "5");
        expect(await pipeline.countRows(scope)).toBe(5);
        expect(pipeline.dlq).toEqual([]);
      });
    },
    TEST_TIMEOUT,
  );
});
