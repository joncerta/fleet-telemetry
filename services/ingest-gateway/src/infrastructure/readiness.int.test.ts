import { createLogger, createPool, databaseConfig, loadConfig } from "@fleet/platform";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createDatabaseCheck } from "./readiness.js";

// Contra TimescaleDB real, con el rol de los servicios (DATABASE_URL): el ping debe funcionar con sus permisos.
const config = loadConfig(z.object(databaseConfig.shape));
const logger = createLogger({ service: "gateway-readiness-it", level: "error" });

let pool: Pool;

beforeAll(() => {
  pool = createPool({ connectionString: config.DATABASE_URL, applicationName: "gateway-readiness-it", logger, max: 1 });
});

afterAll(async () => {
  await pool.end();
});

describe("createDatabaseCheck contra la base real", () => {
  it("es true con la conexión de los servicios", async () => {
    await expect(createDatabaseCheck(pool, logger).check()).resolves.toBe(true);
  });

  it("es false (sin lanzar) cuando no hay base en esa dirección", async () => {
    const url = new URL(config.DATABASE_URL);
    url.port = "1"; // nada escucha ahí
    const unreachable = createPool({ connectionString: url.toString(), applicationName: "gateway-readiness-it-down", logger, max: 1, connectionTimeoutMs: 500 });
    const warn = vi.fn();
    try {
      await expect(createDatabaseCheck(unreachable, { warn }).check()).resolves.toBe(false);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      await unreachable.end();
    }
  });
});
