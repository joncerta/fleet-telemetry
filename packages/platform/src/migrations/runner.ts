import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import type { Logger } from "pino";
import {
  acquireLock,
  backfillDownChecksums,
  ensureControlTable,
  findAppliedDiscrepancies,
  findPending,
  migrationLabel,
  outOfOrderMessage,
  readApplied,
  resolveSessionTimeouts,
  withMigrationClient,
  type AppliedMigration,
  type SessionTimeouts,
} from "./control.js";
import { loadMigrationFiles, MigrationError, type MigrationFile } from "./files.js";
import { assertLocalDatabaseHost, assertLocalEnvironmentMark, ENVIRONMENT_SETTING } from "./local-guard.js";
import { assertRollbackTarget, DEFAULT_ROLLBACK_TARGET, type RollbackTarget } from "./rollback-target.js";
import { setRolePasswords, type RolePasswords } from "./roles.js";
import { timeoutHint } from "./sql-errors.js";
import { splitSqlStatements } from "./sql-statements.js";

/** Carpeta de migraciones del repositorio (`infra/db/migrations`), resuelta desde este archivo. */
export const defaultMigrationsDir = fileURLToPath(new URL("../../../../infra/db/migrations", import.meta.url));

const DEFAULT_LOCK_TIMEOUT_MS = 60_000;

interface RunnerOptions {
  /** Conexión del superusuario (`DATABASE_ADMIN_URL`). */
  adminUrl: string;
  migrationsDir: string;
  logger: Logger;
  /** `lock_timeout` e `idle_in_transaction_session_timeout` de la sesión de migración (ver `DEFAULT_SESSION_TIMEOUTS`). */
  sessionTimeouts?: Partial<SessionTimeouts>;
}

export interface MigrateOptions extends RunnerOptions {
  /** Si se pasa, tras migrar se da `LOGIN` y contraseña a `fleet_app` y `fleet_ro`. */
  rolePasswords?: RolePasswords;
  /** Cuánto esperar el lock si otra corrida lo tiene. Por defecto, 60 s. */
  lockTimeoutMs?: number;
}

export interface MigrateResult {
  /** Migraciones aplicadas en esta corrida, en orden. */
  applied: readonly { version: number; name: string }[];
  /** Migraciones que ya estaban aplicadas y verificadas. */
  alreadyApplied: number;
  /** Migraciones ya aplicadas a las que se les registró, por primera vez, el checksum del down. */
  downChecksumsRegistered: number;
}

export interface RollbackOptions extends RunnerOptions {
  /** Por defecto, solo la última migración aplicada. */
  target?: RollbackTarget;
  lockTimeoutMs?: number;
  /** Solo calcula y registra el plan (sesión de solo lectura, sin lock ni registro de checksums): no revierte nada. */
  dryRun?: boolean;
}

export interface RollbackResult {
  /** Migraciones revertidas en esta corrida, de la más reciente a la más antigua. Vacío en un dry run. */
  reverted: readonly { version: number; name: string }[];
  /** Con `dryRun`: lo que se revertiría, en el mismo orden. Vacío si no es un dry run. */
  wouldRevert: readonly { version: number; name: string }[];
}

export interface MigrationStatus {
  applied: readonly { version: number; name: string; appliedAt: Date; downChecksumRegistered: boolean }[];
  pending: readonly { version: number; name: string }[];
  /** Cualquier incoherencia entre la base y los archivos (checksums, borrados, renombrados, orden). Vacío = sano. */
  discrepancies: readonly string[];
}

/**
 * Aplica las migraciones pendientes de `migrationsDir`:
 * - toma un `pg_advisory_lock` en una sesión dedicada mientras dura la corrida (varias instancias a la vez
 *   aplican cada migración una sola vez);
 * - registra cada una en `schema_migrations` (versión, nombre, sha256 del up y del down, `applied_at`), en su
 *   propia transacción;
 * - **falla si una migración ya aplicada cambió (up o down) o desapareció**: es la forma mecánica de hacer
 *   cumplir "nunca se edita una migración existente". La verificación corre antes de aplicar nada, aunque no
 *   haya pendientes;
 * - hace evolucionar `schema_migrations` de forma idempotente y registra el checksum del down de las filas que
 *   se aplicaron antes de que existiera la columna;
 * - es idempotente: sin pendientes no hace cambios (salvo reasignar las contraseñas de los roles, si se piden).
 *
 * Por defecto cada migración corre dentro de una transacción (y se registra en ella). Las que necesitan sentencias que
 * Postgres o TimescaleDB prohíben dentro de una (`CREATE INDEX CONCURRENTLY`, un continuous aggregate `WITH DATA`,
 * `refresh_continuous_aggregate`) llevan `-- migrate:no-transaction` en la primera línea del up y del down: el runner
 * ejecuta cada sentencia por separado, sin transacción, y las registra DESPUÉS del éxito. Deben ser idempotentes sentencia
 * por sentencia (ver `NO_TRANSACTION_MARKER`). Siguen bajo el mismo advisory lock.
 */
export async function migrate(options: MigrateOptions): Promise<MigrateResult> {
  const { adminUrl, migrationsDir, rolePasswords, logger } = options;
  const timeouts = resolveSessionTimeouts(options.sessionTimeouts);
  const files = await loadMigrationFiles(migrationsDir);

  return withMigrationClient(adminUrl, logger, async (client) => {
    await acquireLock(client, options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
    await ensureControlTable(client);

    const { applied, backfilled } = await verifyAndBackfill(client, files, await readApplied(client), migrationsDir, logger);
    const { pending, outOfOrder } = findPending(files, applied);
    const [firstOutOfOrder] = outOfOrder;
    if (firstOutOfOrder) throw new MigrationError(outOfOrderMessage(firstOutOfOrder, applied));

    const result: { version: number; name: string }[] = [];
    for (const file of pending) {
      await applyOne(client, file, timeouts);
      logger.info({ version: file.version, migration: file.name }, "Migración aplicada");
      result.push({ version: file.version, name: file.name });
    }

    if (rolePasswords) {
      await setRolePasswords(client, rolePasswords);
      logger.info("Roles fleet_app y fleet_ro con login y contraseña configurados");
    }

    return { applied: result, alreadyApplied: files.length - pending.length, downChecksumsRegistered: backfilled };
  }, { timeouts });
}

/**
 * Revierte migraciones ya aplicadas, de la más reciente a la más antigua (`target`; por defecto solo la última):
 * - usa el mismo advisory lock que `migrate`;
 * - valida el checksum del up y del down de **todas** las seleccionadas antes de ejecutar ninguna: si una no
 *   cuadra, no se toca nada;
 * - cada down corre en su propia transacción, junto con el borrado de su fila de `schema_migrations`;
 * - sin nada aplicado, no hace nada;
 * - **solo corre contra una base local**: un down puede destruir datos. Dos guardas: el host de la URL está en la
 *   allowlist (`assertLocalDatabaseHost`, antes de conectar) y el servidor tiene la marca `fleet.environment=local`
 *   (`assertDatabaseMarkedLocal`, justo después de conectar y antes del lock, también en el dry run);
 * - con `dryRun` valida y muestra el plan sin tocar la base.
 */
export async function rollback(options: RollbackOptions): Promise<RollbackResult> {
  const { adminUrl, migrationsDir, logger } = options;
  const target = options.target ?? DEFAULT_ROLLBACK_TARGET;
  assertRollbackTarget(target);
  assertLocalDatabaseHost(adminUrl);
  const timeouts = resolveSessionTimeouts(options.sessionTimeouts);
  const files = await loadMigrationFiles(migrationsDir);

  if (options.dryRun === true) return planRollback({ adminUrl, files, migrationsDir, target, timeouts, logger });

  return withMigrationClient(adminUrl, logger, async (client) => {
    await assertDatabaseMarkedLocal(client);
    await acquireLock(client, options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);

    // Sin nada aplicado no se toca la base (ni siquiera se crea la tabla de control).
    if ((await readApplied(client)).length === 0) {
      logger.info("No hay migraciones aplicadas que revertir");
      return { reverted: [], wouldRevert: [] };
    }
    await ensureControlTable(client);

    const applied = await readApplied(client);
    const selected = select(applied, target);
    if (selected.length === 0) {
      logger.info("No hay migraciones aplicadas que revertir");
      return { reverted: [], wouldRevert: [] };
    }

    // Solo se verifican y se completan las seleccionadas: una discrepancia en otra migración no impide revertir.
    const verified = (await verifyAndBackfill(client, files, selected, migrationsDir, logger)).applied;
    const byVersion = new Map(files.map((file) => [file.version, file]));
    const plan = verified.map((row) => {
      const file = byVersion.get(row.version);
      if (!file) throw new MigrationError(`No se encontró el archivo de la migración ${migrationLabel(row.version, row.name)}.`);
      return file;
    });

    logger.info({ migrations: plan.map((file) => migrationLabel(file.version, file.name)) }, "Se revertirán estas migraciones");
    const reverted: { version: number; name: string }[] = [];
    for (const file of plan) {
      await revertOne(client, file, timeouts);
      logger.info({ version: file.version, migration: file.name }, "Migración revertida");
      reverted.push({ version: file.version, name: file.name });
    }
    return { reverted, wouldRevert: [] };
  }, { timeouts });
}

interface PlanOptions {
  adminUrl: string;
  files: readonly MigrationFile[];
  migrationsDir: string;
  target: RollbackTarget;
  timeouts: SessionTimeouts;
  logger: Logger;
}

/** Lee la marca del servidor y la valida: la base debe declararse local (`fleet.environment=local`). */
async function assertDatabaseMarkedLocal(client: Client): Promise<void> {
  const { rows } = await client.query<{ value: string | null }>("SELECT current_setting($1, true) AS value", [ENVIRONMENT_SETTING]);
  assertLocalEnvironmentMark(rows[0]?.value);
}

/** El `--dry-run` de `rollback`: misma selección y mismas verificaciones, sobre una sesión de solo lectura. */
async function planRollback({ adminUrl, files, migrationsDir, target, timeouts, logger }: PlanOptions): Promise<RollbackResult> {
  return withMigrationClient(
    adminUrl,
    logger,
    async (client) => {
      await assertDatabaseMarkedLocal(client);
      const selected = select(await readApplied(client), target);
      const [problem] = findAppliedDiscrepancies(files, selected, migrationsDir);
      if (problem) throw new MigrationError(problem);

      const wouldRevert = selected.map((row) => ({ version: row.version, name: row.name }));
      if (wouldRevert.length === 0) logger.info("No hay migraciones aplicadas que revertir");
      else {
        logger.info(
          { migrations: wouldRevert.map((m) => migrationLabel(m.version, m.name)) },
          "Dry run: se revertirían estas migraciones (no se tocó la base)",
        );
      }
      return { reverted: [], wouldRevert };
    },
    { readOnly: true, timeouts },
  );
}

/**
 * Estado de las migraciones, de solo lectura (sesión con `default_transaction_read_only`): no toma el lock ni crea
 * ni altera la tabla de control. No lanza ante discrepancias: las devuelve, para que el llamador decida.
 */
export async function getMigrationStatus(options: RunnerOptions): Promise<MigrationStatus> {
  const { adminUrl, migrationsDir, logger } = options;
  const files = await loadMigrationFiles(migrationsDir);

  return withMigrationClient(
    adminUrl,
    logger,
    async (client) => {
      const applied = await readApplied(client);
      const { pending, outOfOrder } = findPending(files, applied);
      return {
        applied: applied.map((row) => ({
          version: row.version,
          name: row.name,
          appliedAt: row.appliedAt,
          downChecksumRegistered: row.downChecksum !== null,
        })),
        pending: pending.map((file) => ({ version: file.version, name: file.name })),
        discrepancies: [...findAppliedDiscrepancies(files, applied, migrationsDir), ...outOfOrder.map((file) => outOfOrderMessage(file, applied))],
      };
    },
    { readOnly: true, timeouts: resolveSessionTimeouts(options.sessionTimeouts) },
  );
}

/** Elige, de la más reciente a la más antigua, las migraciones aplicadas que revierte `target`. */
function select(applied: readonly AppliedMigration[], target: RollbackTarget): AppliedMigration[] {
  const newestFirst = [...applied].sort((a, b) => b.version - a.version);
  if ("steps" in target) return newestFirst.slice(0, target.steps);

  if (target.to !== 0 && !applied.some((row) => row.version === target.to)) {
    throw new MigrationError(`--to ${target.to}: esa migración no está aplicada. Usa 0 para revertirlas todas.`);
  }
  return newestFirst.filter((row) => row.version > target.to);
}

/** Verifica `rows` contra los archivos (falla si algo no cuadra) y registra el down de las que no lo tengan. */
async function verifyAndBackfill(
  client: Client,
  files: readonly MigrationFile[],
  rows: readonly AppliedMigration[],
  dir: string,
  logger: Logger,
): Promise<{ applied: AppliedMigration[]; backfilled: number }> {
  const [problem] = findAppliedDiscrepancies(files, rows, dir);
  if (problem) throw new MigrationError(problem);
  return backfillDownChecksums(client, files, rows, logger);
}

async function applyOne(client: Client, file: MigrationFile, timeouts: SessionTimeouts): Promise<void> {
  if (!file.transactional) return applyWithoutTransaction(client, file, timeouts);
  await client.query("BEGIN");
  try {
    await client.query(file.sql);
    await client.query("INSERT INTO schema_migrations (version, name, checksum, down_checksum) VALUES ($1, $2, $3, $4)", [
      file.version,
      file.name,
      file.checksum,
      file.downChecksum,
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined); // si la conexión murió, ya no hay nada que revertir
    const detail = error instanceof Error ? error.message : "error desconocido";
    const hint = timeoutHint(error, timeouts);
    throw new MigrationError(`La migración ${file.fileName} falló y se revirtió: ${detail}${hint ? ` ${hint}` : ""}`, { cause: error });
  }
}

/**
 * Up sin transacción: una sentencia por `query`, y la fila de `schema_migrations` solo tras el éxito de todas. Si una falla,
 * las anteriores quedan hechas y la migración no queda registrada: el siguiente `db:migrate` la ejecuta entera otra vez, por
 * eso debe ser idempotente sentencia por sentencia.
 */
async function applyWithoutTransaction(client: Client, file: MigrationFile, timeouts: SessionTimeouts): Promise<void> {
  try {
    for (const statement of splitSqlStatements(file.sql)) await client.query(statement);
    await client.query("INSERT INTO schema_migrations (version, name, checksum, down_checksum) VALUES ($1, $2, $3, $4)", [
      file.version,
      file.name,
      file.checksum,
      file.downChecksum,
    ]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "error desconocido";
    const hint = timeoutHint(error, timeouts);
    throw new MigrationError(
      `La migración ${file.fileName} (sin transacción) falló y NO se revirtió: puede haber quedado aplicada en parte y no está registrada. ` +
        `Corrige la causa y vuelve a correr db:migrate: se ejecuta desde la primera sentencia, y debe ser idempotente. ${detail}${hint ? ` ${hint}` : ""}`,
      { cause: error },
    );
  }
}

/** Down sin transacción: igual que el up, y la fila de control se borra solo tras el éxito de todas las sentencias. */
async function revertWithoutTransaction(client: Client, file: MigrationFile, timeouts: SessionTimeouts): Promise<void> {
  try {
    for (const statement of splitSqlStatements(file.downSql)) await client.query(statement);
    await client.query("DELETE FROM schema_migrations WHERE version = $1", [file.version]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "error desconocido";
    const hint = timeoutHint(error, timeouts);
    throw new MigrationError(
      `El down ${file.downFileName} (sin transacción) falló y NO se revirtió: puede haber deshecho parte y la migración sigue registrada como aplicada. ` +
        `Corrige la causa y vuelve a correr db:rollback: debe ser idempotente. ${detail}${hint ? ` ${hint}` : ""}`,
      { cause: error },
    );
  }
}

async function revertOne(client: Client, file: MigrationFile, timeouts: SessionTimeouts): Promise<void> {
  if (!file.transactional) return revertWithoutTransaction(client, file, timeouts);
  await client.query("BEGIN");
  try {
    await client.query(file.downSql);
    await client.query("DELETE FROM schema_migrations WHERE version = $1", [file.version]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    const detail = error instanceof Error ? error.message : "error desconocido";
    const hint = timeoutHint(error, timeouts);
    throw new MigrationError(
      `El down ${file.downFileName} falló y se revirtió; la migración sigue aplicada: ${detail}${hint ? ` ${hint}` : ""}`,
      { cause: error },
    );
  }
}
