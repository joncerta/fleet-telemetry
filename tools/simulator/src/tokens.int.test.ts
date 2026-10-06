import { deviceTokenSchema } from "@fleet/contracts";
import { runSeed, seedVehicles, LocalOnlyError } from "@fleet/dev-data";
import { createLogger, createPool, databaseAdminConfig, defaultMigrationsDir, hashPassword, loadConfig, migrate, sha256Hex } from "@fleet/platform";
import { createTempDatabase, type TempDatabase } from "@fleet/platform/testing";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { acquireDeviceTokens } from "./tokens.js";

// Contra TimescaleDB real, en una base temporal con las migraciones reales, conectando como fleet_app (el rol por defecto
// de los comandos de desarrollo).
const config = loadConfig(z.object(databaseAdminConfig.shape));
const logger = createLogger({ service: "simulator-it", level: "error" });

let db: TempDatabase;
let admin: Pool;
let app: Pool;
let appUrl: string;

beforeAll(async () => {
  db = await createTempDatabase(config.DATABASE_ADMIN_URL);
  await migrate({
    adminUrl: db.adminUrl,
    migrationsDir: defaultMigrationsDir,
    rolePasswords: { fleet_app: config.FLEET_APP_PASSWORD, fleet_ro: config.FLEET_RO_PASSWORD },
    logger,
  });
  admin = createPool({ connectionString: db.adminUrl, applicationName: "simulator-it-admin", logger, max: 2 });
  appUrl = db.urlFor("fleet_app", config.FLEET_APP_PASSWORD);
  app = createPool({ connectionString: appUrl, applicationName: "simulator-it", logger, max: 2 });
  await runSeed(app, { userPassword: "contrasena-de-prueba-12", hash: (password) => hashPassword(password, { N: 1_024, r: 8, p: 1 }) });
});

afterAll(async () => {
  await Promise.all([admin?.end(), app?.end()]);
  await db?.drop();
});

describe("acquireDeviceTokens", () => {
  it("emite un token válido por cada uno de los 30 vehículos sembrados y la base solo guarda su sha256", async () => {
    const vehicles = seedVehicles();

    const tokens = await acquireDeviceTokens({ pool: app, databaseUrl: appUrl, variable: "DATABASE_URL", vehicles });

    expect(tokens.size).toBe(30);
    const { rows } = await admin.query<{ vehicle_id: string; tenant_id: string; token_hash: string; row_text: string }>(
      "SELECT vehicle_id, tenant_id, token_hash, devices::text AS row_text FROM devices WHERE revoked_at IS NULL",
    );
    expect(rows).toHaveLength(30);
    for (const vehicle of vehicles) {
      const token = tokens.get(vehicle.id);
      expect(deviceTokenSchema.safeParse(token).success).toBe(true);
      const row = rows.find((candidate) => candidate.vehicle_id === vehicle.id);
      expect(row).toMatchObject({ tenant_id: vehicle.tenantId, token_hash: sha256Hex(token ?? "") });
      expect(row?.row_text).not.toContain(token);
    }
  });

  it("una segunda corrida rota: revoca los anteriores y deja uno activo por vehículo", async () => {
    const vehicles = seedVehicles();
    const first = await acquireDeviceTokens({ pool: app, databaseUrl: appUrl, variable: "DATABASE_URL", vehicles });

    const second = await acquireDeviceTokens({ pool: app, databaseUrl: appUrl, variable: "DATABASE_URL", vehicles });

    const [vehicle] = vehicles;
    expect(second.get(vehicle?.id ?? "")).not.toBe(first.get(vehicle?.id ?? ""));
    const { rows } = await admin.query<{ active: string }>("SELECT count(*)::text AS active FROM devices WHERE revoked_at IS NULL");
    expect(rows[0]?.active).toBe("30");
  });

  it("la guarda de host rechaza una base que no es local sin emitir nada", async () => {
    const before = await admin.query<{ n: string }>("SELECT count(*)::text AS n FROM devices");

    await expect(
      acquireDeviceTokens({ pool: app, databaseUrl: "postgres://fleet_app:x@db.ejemplo.com:5432/fleet", variable: "DATABASE_URL", vehicles: seedVehicles() }),
    ).rejects.toBeInstanceOf(LocalOnlyError);

    const after = await admin.query<{ n: string }>("SELECT count(*)::text AS n FROM devices");
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });

  it("la guarda de marca rechaza un servidor que no está marcado como local aunque el host sea local", async () => {
    // Una base temporal tiene la marca del servidor local: se simula un servidor sin marca con un pool cuyo `query` devuelve null.
    const unmarked = {
      connect: () => app.connect(),
      query: () => Promise.resolve({ rows: [{ value: null }] }),
    };

    await expect(acquireDeviceTokens({ pool: unmarked, databaseUrl: appUrl, variable: "DATABASE_URL", vehicles: seedVehicles() })).rejects.toBeInstanceOf(LocalOnlyError);
  });
});
