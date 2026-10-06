import { createLogger, createPool, defaultMigrationsDir, hashPassword, loadConfig, databaseAdminConfig, migrate, sha256Hex, verifyPassword } from "@fleet/platform";
import { createTempDatabase, type TempDatabase } from "@fleet/platform/testing";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { issueDeviceToken, VehicleLookupError } from "./device-token.js";
import { assertLocalDatabase } from "./local-only.js";
import { runSeed } from "./seed.js";
import { SEED_TENANTS, SEED_USERS, SEED_ZONES, seedVehicles, zoneCenter } from "./seed-data.js";

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

const PASSWORD = "contrasena-de-prueba-12";
/** scrypt barato para los tests: el de producción cuesta ~150 ms por usuario. El formato y la verificación son los mismos. */
const cheapHash = (password: string) => hashPassword(password, { N: 1_024, r: 8, p: 1 });
const seed = () => runSeed(app, { userPassword: PASSWORD, hash: cheapHash });

const count = async (table: string): Promise<number> => {
  // El nombre de la tabla sale de este archivo (nunca de fuera); aun así solo se acepta de una lista.
  if (!["tenants", "vehicles", "devices", "zones", "users"].includes(table)) throw new Error(`tabla no permitida: ${table}`);
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
    const first = await seed();
    const second = await seed();

    expect(first).toEqual({ tenantsInserted: 2, vehiclesInserted: 30, zonesInserted: 8, usersInserted: 2 });
    expect(second).toEqual({ tenantsInserted: 0, vehiclesInserted: 0, zonesInserted: 0, usersInserted: 0 });
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

    await seed();

    const { rows } = await admin.query<{ label: string }>("SELECT label FROM vehicles WHERE id = $1", [seedVehicles()[0]?.id]);
    expect(rows[0]?.label).toBe("editado");
  });
});

describe("device:token", () => {
  const norte = SEED_TENANTS[0];

  it("crea un dispositivo por placa, guarda el sha256 y no el token en ninguna columna", async () => {
    await seed();

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
    await seed();
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
    await seed();
    await admin.query("INSERT INTO vehicles (id, tenant_id, plate) VALUES (gen_random_uuid(), $1, 'NRT101')", [SEED_TENANTS[1]?.id]);

    await expect(issueDeviceToken(app, "NRT101")).rejects.toThrow(/usa el id/);
  });
});

describe("db:seed: zonas y usuarios", () => {
  it("siembra las zonas con geometría válida y su tenant, y cada centro cae dentro de su propia zona y de ninguna otra del tenant", async () => {
    await seed();

    const { rows } = await admin.query<{ kind: string; n: string }>("SELECT kind, count(*)::text AS n FROM zones GROUP BY kind ORDER BY kind");
    expect(rows).toEqual([
      { kind: "critical", n: "4" },
      { kind: "customer", n: "2" },
      { kind: "depot", n: "2" },
    ]);
    for (const zone of SEED_ZONES) {
      const [lng, lat] = zoneCenter(zone);
      const hit = await admin.query<{ zone_id: string }>(
        "SELECT zone_id FROM zones WHERE tenant_id = $1 AND ST_Covers(geom, ST_SetSRID(ST_MakePoint($2, $3), 4326)) ORDER BY zone_id",
        [zone.tenantId, lng, lat],
      );
      expect(hit.rows, zone.name).toEqual([{ zone_id: zone.zoneId }]);
    }
  });

  it("una zona de un tenant no contiene los puntos de las del otro (Bogotá y Medellín)", async () => {
    await seed();
    const norte = SEED_ZONES.find((zone) => zone.name === "Depósito Norte");
    if (norte === undefined) throw new Error("falta la zona de demo");
    const [lng, lat] = zoneCenter(norte);

    const { rows } = await admin.query("SELECT 1 FROM zones WHERE tenant_id = $1 AND ST_Covers(geom, ST_SetSRID(ST_MakePoint($2, $3), 4326))", [SEED_TENANTS[1]?.id, lng, lat]);

    expect(rows).toEqual([]);
  });

  it("siembra un usuario por tenant cuyo hash es scrypt, verifica con la contraseña y no la contiene", async () => {
    await seed();

    const { rows } = await admin.query<{ user_id: string; tenant_id: string; email: string; password_hash: string }>(
      "SELECT user_id, tenant_id, email, password_hash FROM users ORDER BY email",
    );

    expect(rows.map((row) => row.email)).toEqual(["operador@norte.test", "operador@sur.test"]);
    expect(rows.map((row) => row.tenant_id)).toEqual(SEED_USERS.map((user) => user.tenantId));
    for (const row of rows) {
      expect(row.password_hash).toMatch(/^scrypt\$/);
      expect(row.password_hash).not.toContain(PASSWORD);
      await expect(verifyPassword(PASSWORD, row.password_hash)).resolves.toBe(true);
      await expect(verifyPassword("otra-contrasena", row.password_hash)).resolves.toBe(false);
    }
    // Una sal por usuario: la misma contraseña no da el mismo hash.
    expect(rows[0]?.password_hash).not.toBe(rows[1]?.password_hash);
  });

  it("el login por correo sin distinguir mayúsculas encuentra al usuario de su tenant", async () => {
    await seed();

    const { rows } = await app.query<{ tenant_id: string }>("SELECT tenant_id FROM users WHERE lower(email) = lower($1)", ["Operador@SUR.test"]);

    expect(rows).toEqual([{ tenant_id: SEED_TENANTS[1]?.id }]);
  });

  it("una segunda corrida con otra contraseña no cambia la de los usuarios ya sembrados", async () => {
    await seed();
    const before = await admin.query<{ password_hash: string }>("SELECT password_hash FROM users ORDER BY email");

    const again = await runSeed(app, { userPassword: "otra-contrasena-distinta", hash: cheapHash });

    expect(again.usersInserted).toBe(0);
    expect((await admin.query<{ password_hash: string }>("SELECT password_hash FROM users ORDER BY email")).rows).toEqual(before.rows);
    expect(await count("users")).toBe(2);
    expect(await count("zones")).toBe(8);
  });
});
