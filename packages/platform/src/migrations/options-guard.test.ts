import { describe, expect, it } from "vitest";
import { createLogger } from "../logger/logger.js";
import { MigrationError } from "./files.js";
import { defaultMigrationsDir, getMigrationStatus, migrate, rollback } from "./runner.js";

// Sin base de datos: el puerto 1 de loopback no tiene nada escuchando. Si la guarda faltara, la conexión fallaría
// con ECONNREFUSED (no con `MigrationError`) y el test lo notaría sin tocar la base local.
const logger = createLogger({ service: "options-guard-test", level: "error" });
const migrationsDir = defaultMigrationsDir;
const withOptions = (options: string) => `postgres://fleet:pw@127.0.0.1:1/fleet?options=${encodeURIComponent(options)}`;

const MARK = "-c fleet.environment=local";
const TIMEOUT = "-c lock_timeout=0";

describe.each([MARK, TIMEOUT])("DATABASE_ADMIN_URL con ?options=%s", (options) => {
  const adminUrl = withOptions(options);
  const rejected = /options.*fija sus propios parámetros/s;

  it("migrate lo rechaza antes de conectar", async () => {
    await expect(migrate({ adminUrl, migrationsDir, logger })).rejects.toBeInstanceOf(MigrationError);
    await expect(migrate({ adminUrl, migrationsDir, logger })).rejects.toThrow(rejected);
  });

  it("status lo rechaza antes de conectar", async () => {
    await expect(getMigrationStatus({ adminUrl, migrationsDir, logger })).rejects.toBeInstanceOf(MigrationError);
    await expect(getMigrationStatus({ adminUrl, migrationsDir, logger })).rejects.toThrow(rejected);
  });

  it("rollback lo rechaza antes de conectar", async () => {
    await expect(rollback({ adminUrl, migrationsDir, logger })).rejects.toBeInstanceOf(MigrationError);
    await expect(rollback({ adminUrl, migrationsDir, logger })).rejects.toThrow(/options/);
  });

  it("rollback --dry-run lo rechaza antes de conectar", async () => {
    await expect(rollback({ adminUrl, migrationsDir, logger, dryRun: true })).rejects.toBeInstanceOf(MigrationError);
    await expect(rollback({ adminUrl, migrationsDir, logger, dryRun: true })).rejects.toThrow(/options/);
  });
});
