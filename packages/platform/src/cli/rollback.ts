import { z } from "zod";
import { databaseAdminConfig, logConfig, migrationConfig } from "../config/fragments.js";
import { loadConfig } from "../config/load-config.js";
import { createLogger } from "../logger/logger.js";
import { parseRollbackCommand } from "../migrations/rollback-target.js";
import { defaultMigrationsDir, rollback } from "../migrations/runner.js";

// `pnpm db:rollback [--steps N | --to NNN] [--dry-run]`. Por defecto revierte solo la última migración aplicada.
// SOLO EN LOCAL: rechaza un DATABASE_ADMIN_URL cuyo host no sea 127.0.0.1, localhost, ::1 o timescaledb, y una base
// cuyo servidor no tenga la marca fleet.environment=local.
// `--dry-run` muestra el plan sin tocar la base. Solo necesita la conexión del superusuario, no las contraseñas.
const schema = z.object({
  ...databaseAdminConfig.pick({ DATABASE_ADMIN_URL: true }).shape,
  ...migrationConfig.shape,
  ...logConfig.shape,
});

try {
  const { target, dryRun } = parseRollbackCommand(process.argv.slice(2));
  const config = loadConfig(schema);
  // El plan y el resultado del rollback se imprimen siempre (nivel info como mínimo), aunque LOG_LEVEL sea más callado.
  const logger = createLogger({ service: "db-rollback", level: config.LOG_LEVEL === "debug" ? "debug" : "info" });

  const result = await rollback({
    adminUrl: config.DATABASE_ADMIN_URL,
    migrationsDir: defaultMigrationsDir,
    target,
    dryRun,
    sessionTimeouts: { lockTimeoutMs: config.DB_MIGRATE_LOCK_TIMEOUT_MS },
    logger,
  });

  if (dryRun) {
    logger.info({ wouldRevert: result.wouldRevert.length }, "Dry run terminado: no se revirtió nada");
  } else {
    logger.info({ reverted: result.reverted.length }, result.reverted.length === 0 ? "Nada que revertir" : "Rollback completado");
  }
} catch (error) {
  // ConfigError y MigrationError nombran variables y migraciones, nunca valores ni contraseñas.
  const message = error instanceof Error ? error.message : "error desconocido";
  process.stderr.write(`db:rollback falló: ${message}\n`);
  process.exitCode = 1;
}
