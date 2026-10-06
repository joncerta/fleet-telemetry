import { TELEMETRY_RETENTION_DAYS } from "@fleet/contracts";
import { databaseConfig, kafkaConfig, loadConfig, logConfig, shutdownConfig, type Env } from "@fleet/platform";
import { z } from "zod";

/** Máximo de `INGEST_GATEWAY_BODY_LIMIT_BYTES`: un lote de 500 puntos pesa del orden de 150 KB. */
const MAX_BODY_LIMIT_BYTES = 10 * 1024 * 1024;

/** Máximo de los TTL de la caché de tokens: 5 minutos. Un TTL largo retrasa la revocación. */
const MAX_TOKEN_CACHE_TTL_MS = 300_000;

/** Máximo de la tolerancia de tiempo futuro: 1 hora. */
const MAX_FUTURE_TOLERANCE_MS = 3_600_000;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Máximo de la antigüedad de un punto: la retención de `telemetry`. Aceptar más sería aceptar lo que se va a borrar. */
const MAX_POINT_AGE_MS = TELEMETRY_RETENTION_DAYS * DAY_MS;

const gatewayConfig = z.object({
  INGEST_GATEWAY_HOST: z.string().min(1).default("127.0.0.1"),
  INGEST_GATEWAY_PORT: z.coerce.number().int().min(1).max(65_535).default(4001),
  INGEST_GATEWAY_BODY_LIMIT_BYTES: z.coerce.number().int().min(1_024).max(MAX_BODY_LIMIT_BYTES).default(1_048_576),
  // Cuántos saltos de proxy confiables hay delante (el ALB = 1). Con 0 se ignora X-Forwarded-For. Mal configurado, el límite por IP
  // se vuelve global (se ve la IP del balanceador) o se deja falsear (se confía en un header del cliente).
  INGEST_GATEWAY_TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  // Tope ALTO por IP contra floods: cuenta TODAS las peticiones (también las 202), antes de autenticar.
  INGEST_GATEWAY_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(1_000_000).default(6_000),
  INGEST_GATEWAY_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
  // Límite por IP contra la fuerza bruta de tokens: cuenta SOLO los 401 de esa IP, así que no frena a una flota legítima.
  INGEST_GATEWAY_AUTH_FAILURE_LIMIT_MAX: z.coerce.number().int().min(1).max(1_000_000).default(20),
  INGEST_GATEWAY_AUTH_FAILURE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
  // Límite por dispositivo (identidad verificada), distinto del límite por IP de arriba, que corre antes de autenticar.
  INGEST_GATEWAY_DEVICE_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(1_000_000).default(60),
  INGEST_GATEWAY_DEVICE_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
  // Caché de tokens: la revocación de un dispositivo tarda como máximo el TTL positivo en aplicarse en cada réplica.
  INGEST_GATEWAY_TOKEN_CACHE_TTL_MS: z.coerce.number().int().min(0).max(MAX_TOKEN_CACHE_TTL_MS).default(30_000),
  INGEST_GATEWAY_TOKEN_CACHE_NEGATIVE_TTL_MS: z.coerce.number().int().min(0).max(MAX_TOKEN_CACHE_TTL_MS).default(5_000),
  INGEST_GATEWAY_TOKEN_CACHE_MAX_ENTRIES: z.coerce.number().int().min(1).max(1_000_000).default(10_000),
  // Consultas de autenticación a la base en vuelo como máximo (debajo de la caché: los aciertos no cuentan). Es también el tamaño del
  // pool de autenticación. Por encima, el lote responde 503 con Retry-After sin tocar el pool: un flood de tokens inventados no
  // puede saturar la base ni dejar sin autenticar a los dispositivos cuyo token no está en caché.
  INGEST_GATEWAY_MAX_IN_FLIGHT_AUTH_LOOKUPS: z.coerce.number().int().min(1).max(100).default(8),
  // Cuánto puede adelantarse el `recordedAt` de un punto a la hora del servidor antes de rechazarlo (future_timestamp).
  INGEST_GATEWAY_FUTURE_TOLERANCE_MS: z.coerce.number().int().min(0).max(MAX_FUTURE_TOLERANCE_MS).default(300_000),
  // Antigüedad máxima del `recordedAt` (stale_timestamp). Por defecto 7 días, el umbral de compresión de `telemetry`; como mucho
  // la retención (90 días). Sin cota, un token válido crearía un chunk por cada fecha distinta.
  INGEST_GATEWAY_MAX_AGE_MS: z.coerce.number().int().min(HOUR_MS).max(MAX_POINT_AGE_MS).default(7 * DAY_MS),
  // Tamaño máximo de UN punto serializado, en bytes. Más grande se rechaza como invalid_schema y a la DLQ va solo su inicio.
  INGEST_GATEWAY_MAX_POINT_BYTES: z.coerce.number().int().min(512).max(65_536).default(8_192),
  // Publicación en Kafka: tiempo máximo por envío (si se agota, el lote responde 503) y reintentos del productor.
  INGEST_GATEWAY_PUBLISH_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(8_000),
  // kafkajs exige al menos 1 reintento con el productor idempotente.
  INGEST_GATEWAY_KAFKA_RETRIES: z.coerce.number().int().min(1).max(10).default(3),
  // Envíos a Kafka en vuelo (incluidos los que ya vencieron su timeout y siguen en kafkajs). Por encima, el lote responde 503
  // sin llamar a kafkajs: acota la cola cuando el broker está lento.
  INGEST_GATEWAY_MAX_IN_FLIGHT_PUBLICATIONS: z.coerce.number().int().min(1).max(10_000).default(256),
});

export const configSchema = z.object({
  ...databaseConfig.shape,
  ...kafkaConfig.shape,
  ...logConfig.shape,
  ...shutdownConfig.shape,
  ...gatewayConfig.shape,
});
export type GatewayConfig = z.output<typeof configSchema>;

/** Valida el entorno al arrancar (fail fast): `ConfigError` nombra cada variable con problema, nunca su valor. */
export function loadGatewayConfig(env?: Env): GatewayConfig {
  return env === undefined ? loadConfig(configSchema) : loadConfig(configSchema, env);
}
