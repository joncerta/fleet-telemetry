import { describe, expect, it } from "vitest";
import { createLogger } from "../logger/logger.js";
import { MigrationError } from "./files.js";
import { rollback } from "./runner.js";

// Sin base de datos: la guarda de host debe fallar antes de abrir ninguna conexión.
const logger = createLogger({ service: "rollback-guard-test", level: "error" });
const migrationsDir = "no-se-lee-antes-de-la-guarda";

describe("rollback() solo en local", () => {
  it.each([
    "postgres://fleet:pw@db.prod.example.com:5432/fleet",
    "postgres://fleet:pw@10.0.3.7:5432/fleet",
    "postgres://fleet:pw@localhost:5432/fleet?host=db.prod.example.com",
  ])("rechaza %s, también con dryRun", async (adminUrl) => {
    await expect(rollback({ adminUrl, migrationsDir, logger })).rejects.toBeInstanceOf(MigrationError);
    await expect(rollback({ adminUrl, migrationsDir, logger, dryRun: true })).rejects.toThrow(/base local|parámetro/);
  });
});
