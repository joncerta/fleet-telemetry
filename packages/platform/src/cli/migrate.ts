import { z } from "zod";
import { loadConfig } from "../config/load-config.js";
import { databaseAdminConfig, logConfig, migrationConfig } from "../config/fragments.js";
import { createLogger } from "../logger/logger.js";
import { defaultMigrationsDir, migrate } from "../migrations/runner.js";

// `pnpm db:migrate`. Las variables vienen del entorno; el script raíz carga `.env` con `--env-file-if-exists`.
const schema = z.object({ ...databaseAdminConfig.shape, ...migrationConfig.shape, ...logConfig.shape });

try {
  const config = loadConfig(schema);
  const logger = createLogger({ service: "db-migrate", level: config.LOG_LEVEL });

  const result = await migrate({
    adminUrl: config.DATABASE_ADMIN_URL,
    migrationsDir: defaultMigrationsDir,
    sessionTimeouts: { lockTimeoutMs: config.DB_MIGRATE_LOCK_TIMEOUT_MS },
    rolePasswords: { fleet_app: config.FLEET_APP_PASSWORD, fleet_ro: config.FLEET_RO_PASSWORD },
    logger,
  });

  logger.info(
    { applied: result.applied.length, alreadyApplied: result.alreadyApplied, downChecksumsRegistered: result.downChecksumsRegistered },
    result.applied.length === 0 ? "Sin migraciones pendientes" : "Migraciones aplicadas",
  );
} catch (error) {
  // ConfigError y MigrationError nombran variables y migraciones, nunca valores ni contraseñas.
  const message = error instanceof Error ? error.message : "error desconocido";
  process.stderr.write(`db:migrate falló: ${message}\n`);
  process.exitCode = 1;
}
