import { createKafka, createLogger, createPool, createProducer, installGracefulShutdown, sha256Hex } from "@fleet/platform";
import { createAuthenticateDevice } from "./application/authenticate-device.js";
import { createCheckHealth } from "./application/check-health.js";
import { createReceiveTelemetryBatch } from "./application/receive-telemetry-batch.js";
import { loadGatewayConfig } from "./config.js";
import { createCachedDeviceRepository } from "./infrastructure/cached-device-repository.js";
import { createFixedWindowFailureCounter } from "./infrastructure/fixed-window-failure-counter.js";
import { createKafkaTelemetryPublisher } from "./infrastructure/kafka-telemetry-publisher.js";
import { createPgDeviceRepository } from "./infrastructure/pg-device-repository.js";
import { createDatabaseCheck, createKafkaCheck, ProducerConnectionState } from "./infrastructure/readiness.js";
import { buildApp } from "./interfaces/http/build-app.js";
import { registerTelemetryRoute } from "./interfaces/http/telemetry-route.js";

// Único composition root del ingest-gateway: aquí se crean y se conectan los adaptadores. Nada más del servicio
// construye infraestructura. Si la configuración es inválida, `loadGatewayConfig` lanza y el proceso no arranca.
const SERVICE = "ingest-gateway";

const config = loadGatewayConfig();
const logger = createLogger({ service: SERVICE, level: config.LOG_LEVEL });

const kafka = createKafka({ brokers: config.KAFKA_BROKERS, clientId: SERVICE, logger });
// Reintentos acotados con backoff exponencial y jitter (los de kafkajs): el peor caso suma unos segundos, por debajo del
// tiempo máximo por envío (INGEST_GATEWAY_PUBLISH_TIMEOUT_MS), que es lo que decide el 503.
const producer = createProducer(kafka, { retry: { retries: config.INGEST_GATEWAY_KAFKA_RETRIES, initialRetryTime: 100, maxRetryTime: 2_000 } });
const producerState = new ProducerConnectionState();
const pool = createPool({ connectionString: config.DATABASE_URL, applicationName: SERVICE, logger });

const authenticateDevice = createAuthenticateDevice({
  devices: createCachedDeviceRepository(createPgDeviceRepository(pool), {
    ttlMs: config.INGEST_GATEWAY_TOKEN_CACHE_TTL_MS,
    negativeTtlMs: config.INGEST_GATEWAY_TOKEN_CACHE_NEGATIVE_TTL_MS,
    maxEntries: config.INGEST_GATEWAY_TOKEN_CACHE_MAX_ENTRIES,
  }),
  hashToken: sha256Hex,
});
const receiveBatch = createReceiveTelemetryBatch({
  publisher: createKafkaTelemetryPublisher({
    producer,
    timeoutMs: config.INGEST_GATEWAY_PUBLISH_TIMEOUT_MS,
    maxInFlight: config.INGEST_GATEWAY_MAX_IN_FLIGHT_PUBLICATIONS,
  }),
  clock: { now: () => new Date() },
  futureToleranceMs: config.INGEST_GATEWAY_FUTURE_TOLERANCE_MS,
  maxAgeMs: config.INGEST_GATEWAY_MAX_AGE_MS,
  maxPointBytes: config.INGEST_GATEWAY_MAX_POINT_BYTES,
});

const app = await buildApp({
  logger,
  trustProxyHops: config.INGEST_GATEWAY_TRUSTED_PROXY_HOPS,
  bodyLimitBytes: config.INGEST_GATEWAY_BODY_LIMIT_BYTES,
  rateLimit: { max: config.INGEST_GATEWAY_RATE_LIMIT_MAX, timeWindowMs: config.INGEST_GATEWAY_RATE_LIMIT_WINDOW_MS },
  checkHealth: createCheckHealth([createDatabaseCheck(pool, logger), createKafkaCheck(producerState)]),
  registerRoutes: (instance) =>
    registerTelemetryRoute(instance, {
      authenticate: authenticateDevice,
      receiveBatch,
      deviceRateLimit: { max: config.INGEST_GATEWAY_DEVICE_RATE_LIMIT_MAX, timeWindowMs: config.INGEST_GATEWAY_DEVICE_RATE_LIMIT_WINDOW_MS },
      authFailureLimiter: createFixedWindowFailureCounter({
        max: config.INGEST_GATEWAY_AUTH_FAILURE_LIMIT_MAX,
        timeWindowMs: config.INGEST_GATEWAY_AUTH_FAILURE_LIMIT_WINDOW_MS,
      }),
    }),
});

// Se instala antes de conectar nada: un fallo al arrancar también cierra de forma ordenada lo que ya se abrió.
const lifecycle = installGracefulShutdown({
  logger,
  timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
  steps: [
    // 1) /health pasa a 503 de inmediato, para que el balanceador deje de enviar tráfico.
    { name: "marcar el servicio como no listo", run: () => Promise.resolve(producerState.markDisconnected()) },
    // 2) Deja de aceptar conexiones nuevas y espera a las peticiones en vuelo.
    { name: "cerrar el servidor HTTP", run: () => app.close() },
    // 3) Con nada en vuelo, ya se pueden cerrar el productor y el pool.
    { name: "desconectar el productor de Kafka", run: () => producer.disconnect() },
    { name: "cerrar el pool de Postgres", run: () => pool.end() },
  ],
});

try {
  await producer.connect();
  producerState.markConnected();
  await app.listen({ host: config.INGEST_GATEWAY_HOST, port: config.INGEST_GATEWAY_PORT });
  logger.info({ host: config.INGEST_GATEWAY_HOST, port: config.INGEST_GATEWAY_PORT }, "ingest-gateway escuchando");
} catch (err) {
  logger.error({ err }, "No se pudo arrancar el ingest-gateway");
  await lifecycle.shutdown("fallo de arranque", 1);
}
