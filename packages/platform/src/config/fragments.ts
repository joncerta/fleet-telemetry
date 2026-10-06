import { z } from "zod";
import { SESSION_SECRET_MIN_BYTES } from "../security/session-codec.js";

// Fragmentos reutilizables: cada servicio compone su esquema con `z.object({ ...a.shape, ...b.shape })`.
// Toda variable nueva se documenta también en `.env.example`.

const postgresUrl = z.url({ protocol: /^postgres(ql)?$/ });
const secret = z.string().min(1);
const broker = z.string().regex(/^[^\s:,]+:\d{1,5}$/);

/** Conexión de los servicios (rol `fleet_app`, DML). */
export const databaseConfig = z.object({
  DATABASE_URL: postgresUrl,
});

/** Conexión de solo lectura (rol `fleet_ro`): verificación y tests de permisos. */
export const databaseReadOnlyConfig = z.object({
  DATABASE_RO_URL: postgresUrl,
});

/** Superusuario y contraseñas de los roles. Solo para `pnpm db:migrate` y los tests; los servicios no lo usan. */
export const databaseAdminConfig = z.object({
  DATABASE_ADMIN_URL: postgresUrl,
  FLEET_APP_PASSWORD: secret,
  FLEET_RO_PASSWORD: secret,
});

/**
 * Tope de espera por locks de la sesión de `db:migrate` y `db:rollback` (`lock_timeout`). Por defecto 8 s; entre 1 y
 * 60 s. Si se agota, el error pide reintentar en una ventana de menos carga.
 */
export const migrationConfig = z.object({
  DB_MIGRATE_LOCK_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(8_000),
});

/** `KAFKA_BROKERS` es una lista `host:puerto` separada por comas. */
export const kafkaConfig = z.object({
  KAFKA_BROKERS: z
    .string()
    .transform((value) =>
      value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item !== ""),
    )
    .pipe(z.array(broker).min(1)),
});

/**
 * Secreto con el que se firma la cookie de sesión (HMAC-SHA256, ver `createSessionCodec`). Lo comparten fleet-api (la emite) y el
 * agente (la valida): debe ser el mismo en ambos. Al menos 32 bytes (UTF-8); un secreto más corto hace fallar el arranque.
 */
export const sessionSecretConfig = z.object({
  SESSION_SECRET: z.string().refine((value) => Buffer.byteLength(value, "utf8") >= SESSION_SECRET_MIN_BYTES, {
    error: `SESSION_SECRET debe tener al menos ${SESSION_SECRET_MIN_BYTES} bytes`,
  }),
});

export const LOG_LEVELS =["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const logConfig = z.object({
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
});

/**
 * Tope del apagado ordenado de los servicios (ver `installGracefulShutdown`), en ms (1000-120000). Por defecto 15 s.
 * Debe ser menor que el `stop_grace_period` / `terminationGracePeriod` del orquestador, o este mata al proceso antes.
 */
export const shutdownConfig = z.object({
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),
});
