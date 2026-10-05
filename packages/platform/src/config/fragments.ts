import { z } from "zod";

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

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const logConfig = z.object({
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
});
