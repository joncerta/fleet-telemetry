import { createLogger, createPool, defaultMigrationsDir, loadConfig, databaseAdminConfig, migrate, sha256Hex } from "@fleet/platform";
import { createTempDatabase, type TempDatabase } from "@fleet/platform/testing";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { issueDeviceToken, VehicleLookupError } from "./device-token.js";
import { assertLocalDatabase } from "./local-only.js";
import { runSeed } from "./seed.js";
import { SEED_TENANTS, seedVehicles } from "./seed-data.js";

// Contra TimescaleDB real, en una base temporal con las migraciones reales, conectando como fleet_app (el rol que
// usan los comandos por defecto): así también se prueba que sus permisos alcanzan.
const config = loadConfig(z.object(databaseAdminConfig.shape));
const logger = createLogger({ service: "dev-data-it", level: "error" });

let db: TempDatabase;
let admin: Pool;
let app: Pool;

beforeAll(async () => {
  db = await createTempDatabase(config.DATABASE_ADMIN_URL);
  await migrate({
    adminUrl: db.adminUrl,
    migrationsDir: defaultMigrationsDir,
    rolePasswords: { fleet_app: config.FLEET_APP_PASSWORD, fleet_ro: config.FLEET_RO_PASSWORD },
    logger,
  });
  admin = createPool({ connectionString: db.adminUrl, applicationName: "dev-data-it-admin", logger, max: 2 });
  app = createPool({ connectionString: db.urlFor("fleet_app", config.FLEET_APP_PASSWORD), applicationName: "dev-data-it", logger, max: 2 });
});

afterAll(async () => {
  await Promise.all([admin?.end(), app?.end()]);
  await db?.drop();
});

const count = async (table: string): Promise<number> => {
  // El nombre de la tabla sale de este archivo (nunca de fuera); aun así solo se acepta de una lista.
  if (!["tenants", "vehicles", "devices"].includes(table)) throw new Error(`tabla no permitida: ${table}`);
  const { rows } = await admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
  return Number(rows[0]?.n);
};

describe("guardas de base local", () => {
  it("la base local del stack pasa las dos guardas aun conectando como fleet_app (la marca es legible sin privilegios)", async () => {
    await expect(
      assertLocalDatabase({ url: db.urlFor("fleet_app", config.FLEET_APP_PASSWORD), variable: "DATABASE_URL", command: "db:seed", db: app }),
    ).resolves.toBeUndefined();
  });
});

describe("db:seed", () => {
  it("siembra 2 tenants y 15 vehículos por tenant, y una segunda corrida no cambia nada", async () => {
    const first = await runSeed(app);
    const second = await runSeed(app);

    expect(first).toEqual({ tenantsInserted: 2, vehiclesInserted: 30 });
    expect(second).toEqual({ tenantsInserted: 0, vehiclesInserted: 0 });
    expect(await count("tenants")).toBe(2);
    expect(await count("vehicles")).toBe(30);
    const { rows } = await admin.query<{ name: string; vehicles: string }>(
      "SELECT t.name, count(v.id)::text AS vehicles FROM tenants t JOIN vehicles v ON v.tenant_id = t.id GROUP BY t.name ORDER BY t.name",
    );
    expect(rows).toEqual([
      { name: "Flota Norte", vehicles: "15" },
      { name: "Flota Sur", vehicles: "15" },
    ]);
  });

  it("no pisa lo que alguien editó a mano", async () => {
    await admin.query("UPDATE vehicles SET label = 'editado' WHERE id = $1", [seedVehicles()[0]?.id]);

    await runSeed(app);

    const { rows } = await admin.query<{ label: string }>("SELECT label FROM vehicles WHERE id = $1", [seedVehicles()[0]?.id]);
    expect(rows[0]?.label).toBe("editado");
  });
});

describe("device:token", () => {
  const norte = SEED_TENANTS[0];

  it("crea un dispositivo por placa, guarda el sha256 y no el token en ninguna columna", async () => {
    await runSeed(app);

    const issued = await issueDeviceToken(app, "NRT101");

    const { rows } = await admin.query<{ id: string; tenant_id: string; vehicle_id: string; token_hash: string; revoked_at: Date | null; row_text: string }>(
      "SELECT id, tenant_id, vehicle_id, token_hash, revoked_at, devices::text AS row_text FROM devices WHERE id = $1",
      [issued.deviceId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenant_id: norte?.id, vehicle_id: issued.vehicleId, token_hash: sha256Hex(issued.token), revoked_at: null });
    expect(rows[0]?.row_text).not.toContain(issued.token);
    expect(issued.revokedDevices).toBe(0);
  });

  it("rota: revoca el dispositivo anterior y deja uno solo activo", async () => {
    await runSeed(app);
    const vehicleId = seedVehicles()[1]?.id;
    const first = await issueDeviceToken(app, vehicleId ?? "");

    const second = await issueDeviceToken(app, "NRT102");

    expect(second.revokedDevices).toBe(1);
    expect(second.token).not.toBe(first.token);
    const { rows } = await admin.query<{ id: string; active: boolean }>(
      "SELECT id, revoked_at IS NULL AS active FROM devices WHERE vehicle_id = $1 ORDER BY created_at",
      [vehicleId],
    );
    expect(rows).toEqual([
      { id: first.deviceId, active: false },
      { id: second.deviceId, active: true },
    ]);
  });

  it("falla con un vehículo que no existe sin dejar nada a medias", async () => {
    const before = await count("devices");

    await expect(issueDeviceToken(app, "ZZZ999")).rejects.toBeInstanceOf(VehicleLookupError);

    expect(await count("devices")).toBe(before);
  });

  it("pide el id cuando la placa existe en dos tenants", async () => {
    await runSeed(app);
    await admin.query("INSERT INTO vehicles (id, tenant_id, plate) VALUES (gen_random_uuid(), $1, 'NRT101')", [SEED_TENANTS[1]?.id]);

    await expect(issueDeviceToken(app, "NRT101")).rejects.toThrow(/usa el id/);
  });
});
