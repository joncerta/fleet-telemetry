import { Client } from "pg";
import type { Logger } from "pino";
import { z } from "zod";
import { MigrationError, type MigrationFile } from "./files.js";

/**
 * Clave del `pg_advisory_lock` del runner. Los advisory locks son por base de datos, así que dos corridas sobre
 * la misma base se serializan y bases distintas no se bloquean entre sí. La comparten `migrate` y `rollback`.
 */
const MIGRATION_LOCK_KEY = "728000001";
const LOCK_POLL_MS = 200;

const appliedRow = z.object({
  version: z.number().int(),
  name: z.string(),
  checksum: z.string(),
  /** `null` en las filas anteriores a la reversibilidad: se registra la primera vez que corre `migrate` o `rollback`. */
  down_checksum: z.string().nullable(),
  applied_at: z.date(),
});

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly downChecksum: string | null;
  readonly appliedAt: Date;
}

export const migrationLabel = (version: number, name: string): string => `${String(version).padStart(3, "0")}_${name}`;

/**
 * Topes de la sesión de migración, para que una migración no se quede esperando indefinidamente a una transacción
 * larga de la aplicación (ni deje ella misma una transacción abierta que bloquee a los servicios).
 */
export interface SessionTimeouts {
  /** `lock_timeout`: cuánto espera una sentencia un lock de tabla, fila u objeto. Distinto del advisory lock del runner. */
  readonly lockTimeoutMs: number;
  /** `idle_in_transaction_session_timeout`: inactividad máxima dentro de una transacción. */
  readonly idleInTransactionTimeoutMs: number;
}

/** 8 s de espera por locks (entre 5 y 10 s) y 60 s de inactividad en transacción. */
export const DEFAULT_SESSION_TIMEOUTS: SessionTimeouts = { lockTimeoutMs: 8_000, idleInTransactionTimeoutMs: 60_000 };

export function resolveSessionTimeouts(overrides: Partial<SessionTimeouts> = {}): SessionTimeouts {
  const timeouts = { ...DEFAULT_SESSION_TIMEOUTS, ...overrides };
  for (const [name, value] of Object.entries(timeouts)) {
    // Entran al texto de `options` de la conexión: solo enteros positivos.
    if (!Number.isSafeInteger(value) || value < 1) throw new MigrationError(`${name} debe ser un entero positivo de milisegundos.`);
  }
  return timeouts;
}

interface ClientOptions {
  readonly readOnly?: boolean;
  readonly timeouts?: SessionTimeouts;
}

/** Abre una sesión dedicada del superusuario, la entrega a `run` y siempre la cierra (lo que libera el advisory lock). */
export async function withMigrationClient<T>(
  adminUrl: string,
  logger: Logger,
  run: (client: Client) => Promise<T>,
  { readOnly = false, timeouts = DEFAULT_SESSION_TIMEOUTS }: ClientOptions = {},
): Promise<T> {
  const { lockTimeoutMs, idleInTransactionTimeoutMs } = resolveSessionTimeouts(timeouts);
  const settings = [
    "-c timezone=UTC",
    `-c lock_timeout=${lockTimeoutMs}`,
    `-c idle_in_transaction_session_timeout=${idleInTransactionTimeoutMs}`,
    ...(readOnly ? ["-c default_transaction_read_only=on"] : []),
  ];
  const client = new Client({ connectionString: adminUrl, application_name: "fleet-db-migrate", options: settings.join(" ") });
  // Sin listener, un corte de la conexión emitiría `error` sin manejar y tumbaría el proceso sin explicación.
  client.on("error", (err) => logger.error({ err }, "Error en la conexión de migración"));
  await client.connect();

  try {
    return await run(client);
  } finally {
    await client.end().catch((err: unknown) => logger.warn({ err }, "No se pudo cerrar limpiamente la conexión de migración"));
  }
}

export async function acquireLock(client: Client, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1::bigint) AS locked", [MIGRATION_LOCK_KEY]);
    if (rows[0]?.locked === true) return;
    if (Date.now() >= deadline) {
      throw new MigrationError(`Otra instancia de db:migrate tiene el lock desde hace más de ${timeoutMs} ms. Reintenta cuando termine.`);
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }
}

/**
 * Crea la tabla de control y la hace evolucionar de forma idempotente: `down_checksum` se añadió con la
 * reversibilidad, y la base local ya tenía filas sin ella. No borra ni recrea nada.
 */
export async function ensureControlTable(client: Client): Promise<void> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version integer PRIMARY KEY,
       name text NOT NULL,
       checksum text NOT NULL,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
  await client.query("ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS down_checksum text");
}

/**
 * Lee lo aplicado, ordenado por versión. Tolera una base sin tabla de control o sin la columna `down_checksum`
 * (comandos de solo lectura como `status` no deben crear ni alterar nada).
 */
export async function readApplied(client: Client): Promise<AppliedMigration[]> {
  const table = await client.query<{ present: boolean }>("SELECT to_regclass('schema_migrations') IS NOT NULL AS present");
  if (table.rows[0]?.present !== true) return [];

  const column = await client.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_attribute
       WHERE attrelid = 'schema_migrations'::regclass AND attname = 'down_checksum' AND NOT attisdropped
     ) AS present`,
  );
  const downColumn = column.rows[0]?.present === true ? "down_checksum" : "NULL::text AS down_checksum";
  const { rows } = await client.query(`SELECT version, name, checksum, ${downColumn}, applied_at FROM schema_migrations ORDER BY version`);
  return rows.map((row: unknown) => {
    const parsed = appliedRow.parse(row);
    return {
      version: parsed.version,
      name: parsed.name,
      checksum: parsed.checksum,
      downChecksum: parsed.down_checksum,
      appliedAt: parsed.applied_at,
    };
  });
}

/**
 * Compara lo aplicado con los archivos y devuelve todas las discrepancias (vacío si todo cuadra):
 * migración borrada o renombrada, up editado y down editado. Un `down_checksum` sin registrar (`null`) no es
 * discrepancia: se registra la primera vez que corre `migrate` o `rollback`.
 */
export function findAppliedDiscrepancies(files: readonly MigrationFile[], applied: readonly AppliedMigration[], dir: string): string[] {
  const byVersion = new Map(files.map((file) => [file.version, file]));
  const problems: string[] = [];

  for (const row of applied) {
    const file = byVersion.get(row.version);
    if (!file) {
      problems.push(`La migración ${migrationLabel(row.version, row.name)}.sql está aplicada pero ya no existe en ${dir}. Nunca se borra una migración aplicada.`);
      continue;
    }
    if (file.name !== row.name) {
      problems.push(`La migración ${row.version} se aplicó como "${row.name}" y ahora se llama "${file.name}". Nunca se renombra una migración aplicada.`);
      continue;
    }
    if (file.checksum !== row.checksum) {
      problems.push(
        `El checksum de ${file.fileName} cambió desde que se aplicó (aplicado ${row.checksum.slice(0, 12)}, actual ${file.checksum.slice(0, 12)}). ` +
          "Nunca se edita una migración existente: revierte el cambio y crea una migración nueva con el siguiente número libre.",
      );
    }
    if (row.downChecksum !== null && file.downChecksum !== row.downChecksum) {
      problems.push(
        `El checksum de ${file.downFileName} cambió desde que se aplicó la migración (registrado ${row.downChecksum.slice(0, 12)}, actual ${file.downChecksum.slice(0, 12)}). ` +
          "Nunca se edita una migración existente, ni su down: revierte el cambio y crea una migración nueva.",
      );
    }
  }
  return problems;
}

/** Migraciones pendientes (en orden) y las que, siendo pendientes, tienen un número menor que la última aplicada. */
export function findPending(
  files: readonly MigrationFile[],
  applied: readonly AppliedMigration[],
): { pending: MigrationFile[]; outOfOrder: MigrationFile[] } {
  const appliedVersions = new Set(applied.map((row) => row.version));
  const lastApplied = applied.reduce((max, row) => Math.max(max, row.version), 0);
  const pending = files.filter((file) => !appliedVersions.has(file.version));
  return { pending, outOfOrder: pending.filter((file) => file.version < lastApplied) };
}

export function outOfOrderMessage(file: MigrationFile, applied: readonly AppliedMigration[]): string {
  const lastApplied = applied.reduce((max, row) => Math.max(max, row.version), 0);
  return `La migración pendiente ${file.fileName} tiene un número menor que la última aplicada (${lastApplied}). Usa el siguiente número libre.`;
}

/**
 * Registra el checksum del down de las filas que no lo tienen, tomando el del archivo actual. Solo se llama con
 * lo ya verificado (el up no cambió). Devuelve las filas con el checksum y cuántas se actualizaron.
 */
export async function backfillDownChecksums(
  client: Client,
  files: readonly MigrationFile[],
  applied: readonly AppliedMigration[],
  logger: Logger,
): Promise<{ applied: AppliedMigration[]; backfilled: number }> {
  const byVersion = new Map(files.map((file) => [file.version, file]));
  let backfilled = 0;
  const result: AppliedMigration[] = [];
  for (const row of applied) {
    const file = byVersion.get(row.version);
    if (row.downChecksum === null && file) {
      await client.query("UPDATE schema_migrations SET down_checksum = $1 WHERE version = $2 AND down_checksum IS NULL", [
        file.downChecksum,
        row.version,
      ]);
      logger.info({ version: row.version, migration: row.name }, "Checksum del down registrado para una migración ya aplicada");
      backfilled += 1;
      result.push({ ...row, downChecksum: file.downChecksum });
    } else {
      result.push(row);
    }
  }
  return { applied: result, backfilled };
}
