import { z } from "zod";
import { databaseAdminConfig, logConfig } from "../config/fragments.js";
import { loadConfig } from "../config/load-config.js";
import { createLogger } from "../logger/logger.js";
import { formatMigrationStatus } from "../migrations/format-status.js";
import { defaultMigrationsDir, getMigrationStatus } from "../migrations/runner.js";

// `pnpm db:status`: migraciones aplicadas y pendientes, solo lectura. Sale con 1 si hay una discrepancia
// (checksum del up o del down, migración borrada o renombrada, número fuera de orden). Las pendientes no fallan.
const schema = z.object({ ...databaseAdminConfig.pick({ DATABASE_ADMIN_URL: true }).shape, ...logConfig.shape });

try {
  const config = loadConfig(schema);
  const logger = createLogger({ service: "db-status", level: config.LOG_LEVEL });

  const status = await getMigrationStatus({ adminUrl: config.DATABASE_ADMIN_URL, migrationsDir: defaultMigrationsDir, logger });

  process.stdout.write(formatMigrationStatus(status));
  if (status.discrepancies.length > 0) process.exitCode = 1;
} catch (error) {
  const message = error instanceof Error ? error.message : "error desconocido";
  process.stderr.write(`db:status falló: ${message}\n`);
  process.exitCode = 1;
}
