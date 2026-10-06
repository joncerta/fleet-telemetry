import { setTimeout as delay } from "node:timers/promises";
import { TOPICS } from "@fleet/contracts";
import { createConsumer, createKafka, createLogger, createPool, createProducer, installGracefulShutdown } from "@fleet/platform";
import { createPersistTelemetryBatch } from "./application/persist-telemetry-batch.js";
import { loadProcessorConfig } from "./config.js";
import { createKafkaDeadLetterPublisher } from "./infrastructure/kafka-dead-letter-publisher.js";
import { createPgTelemetryRepository } from "./infrastructure/pg-telemetry-repository.js";
import { createTelemetryBatchHandler } from "./interfaces/kafka/telemetry-batch-handler.js";
import { createTelemetryConsumerRunner } from "./interfaces/kafka/telemetry-consumer.js";

// Único composition root del processor: aquí se crean y se conectan los adaptadores. Si la configuración es inválida,
// `loadProcessorConfig` lanza y el proceso no arranca.
const SERVICE = "processor";
/** Cada cuánto late el heartbeat durante una espera: el `heartbeatInterval` del consumer de la plataforma (3 s, con `sessionTimeout` de 30 s). */
const HEARTBEAT_INTERVAL_MS = 3_000;

const config = loadProcessorConfig();
const logger = createLogger({ service: SERVICE, level: config.LOG_LEVEL });

const kafka = createKafka({ brokers: config.KAFKA_BROKERS, clientId: SERVICE, logger });
const consumer = createConsumer(kafka, { groupId: config.PROCESSOR_CONSUMER_GROUP });
// Productor único del proceso, solo para la DLQ. Reintentos acotados con backoff y jitter (los de kafkajs): el peor caso
// suma unos segundos, por debajo del tiempo máximo por envío (PROCESSOR_DLQ_PUBLISH_TIMEOUT_MS), que es lo que decide el fallo.
const producer = createProducer(kafka, { retry: { retries: 3, initialRetryTime: 100, maxRetryTime: 2_000 } });
const pool = createPool({ connectionString: config.DATABASE_URL, applicationName: SERVICE, logger });

const persistTelemetryBatch = createPersistTelemetryBatch({
  repository: createPgTelemetryRepository(pool),
  deadLetters: createKafkaDeadLetterPublisher({ producer, timeoutMs: config.PROCESSOR_DLQ_PUBLISH_TIMEOUT_MS }),
  clock: { now: () => new Date() },
  sleeper: { sleep: (ms) => delay(ms) },
  // El jitter no necesita aleatoriedad criptográfica.
  random: { next: () => Math.random() },
  logger,
  maxAttempts: config.PROCESSOR_MAX_ATTEMPTS,
  backoff: { initialDelayMs: config.PROCESSOR_RETRY_INITIAL_DELAY_MS, maxDelayMs: config.PROCESSOR_RETRY_MAX_DELAY_MS },
  chunkSize: config.PROCESSOR_INSERT_CHUNK_SIZE,
  heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
});

const runner = createTelemetryConsumerRunner({
  consumer,
  topic: TOPICS.telemetryRaw,
  groupId: config.PROCESSOR_CONSUMER_GROUP,
  handler: createTelemetryBatchHandler(persistTelemetryBatch),
  logger,
  // Un consumer caído sin reinicio deja el proceso vivo y sin consumir: se apaga con código 1 para que el orquestador lo reinicie.
  onFatal: (reason) => {
    void lifecycle.shutdown(reason, 1);
  },
});

// Se instala antes de conectar nada: un fallo al arrancar también cierra de forma ordenada lo que ya se abrió.
const lifecycle = installGracefulShutdown({
  logger,
  timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
  steps: [
    // 1) Deja de consumir, espera al lote en vuelo (que persiste y publica en la DLQ) y desconecta el consumer.
    { name: "detener y desconectar el consumer", run: () => runner.stop() },
    // 2) Con nada en vuelo, ya se pueden cerrar el productor y el pool.
    { name: "desconectar el productor de Kafka", run: () => producer.disconnect() },
    { name: "cerrar el pool de Postgres", run: () => pool.end() },
  ],
});

try {
  // El productor se conecta antes de consumir: el primer lote ya puede necesitar la DLQ.
  await producer.connect();
  await runner.start();
  logger.info({ groupId: config.PROCESSOR_CONSUMER_GROUP }, "processor consumiendo");
} catch (err) {
  logger.error({ err }, "No se pudo arrancar el processor");
  await lifecycle.shutdown("fallo de arranque", 1);
}
