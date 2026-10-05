import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../logger/logger.js";
import { integrationConfig as config } from "../testing/integration-support.js";
import { createTempDatabase, type TempDatabase } from "../testing/temp-database.js";
import { defaultMigrationsDir, migrate } from "./runner.js";

// Permisos de los roles en una base temporal. La tabla la crea el admin DESPUÉS de migrar, así que los permisos
// dependen de los ALTER DEFAULT PRIVILEGES de la migración 001.
let db: TempDatabase | undefined;
let app: Client | undefined;
let ro: Client | undefined;
let admin: Client | undefined;

beforeAll(async () => {
  const temp = await createTempDatabase(config.DATABASE_ADMIN_URL);
  db = temp;
  await migrate({
    adminUrl: temp.adminUrl,
    migrationsDir: defaultMigrationsDir,
    rolePasswords: { fleet_app: config.FLEET_APP_PASSWORD, fleet_ro: config.FLEET_RO_PASSWORD },
    logger: createLogger({ service: "permissions-it", level: "error" }),
  });

  admin = new Client({ connectionString: temp.adminUrl });
  await admin.connect();
  await admin.query("CREATE TABLE probe (id serial PRIMARY KEY, label text NOT NULL)");
  await admin.query("INSERT INTO probe (label) VALUES ('semilla')");

  app = new Client({ connectionString: temp.urlFor("fleet_app", config.FLEET_APP_PASSWORD) });
  ro = new Client({ connectionString: temp.urlFor("fleet_ro", config.FLEET_RO_PASSWORD) });
  await Promise.all([app.connect(), ro.connect()]);
});

afterAll(async () => {
  await Promise.all([app?.end(), ro?.end(), admin?.end()]);
  await db?.drop();
});

function client(c: Client | undefined): Client {
  if (!c) throw new Error("El cliente no se inicializó: falló beforeAll");
  return c;
}

describe("autenticación con el verificador SCRAM (los roles se crearon con el verificador, no con la contraseña en claro)", () => {
  it("guarda un verificador SCRAM-SHA-256 en pg_authid, no la contraseña", async () => {
    const { rows } = await client(admin).query<{ rolname: string; rolpassword: string }>(
      "SELECT rolname, rolpassword FROM pg_authid WHERE rolname = ANY($1::text[]) ORDER BY rolname",
      [["fleet_app", "fleet_ro"]],
    );

    expect(rows.map((row) => row.rolname)).toEqual(["fleet_app", "fleet_ro"]);
    for (const row of rows) expect(row.rolpassword).toMatch(/^SCRAM-SHA-256\$4096:/);
  });

  it.each([
    ["fleet_app", "contraseña-incorrecta"],
    ["fleet_ro", "contraseña-incorrecta"],
  ])("rechaza a %s con una contraseña distinta (28P01) por TCP, y acepta la real", async (role, wrong) => {
    const temp = db;
    if (!temp) throw new Error("La base temporal no se inicializó: falló beforeAll");
    const real = role === "fleet_app" ? config.FLEET_APP_PASSWORD : config.FLEET_RO_PASSWORD;

    const bad = new Client({ connectionString: temp.urlFor(role, wrong) });
    await expect(bad.connect()).rejects.toMatchObject({ code: "28P01" });
    await bad.end().catch(() => undefined);

    const good = new Client({ connectionString: temp.urlFor(role, real) });
    await good.connect();
    expect((await good.query<{ who: string }>("SELECT current_user AS who")).rows[0]?.who).toBe(role);
    await good.end();
  });
});

describe("fleet_ro (solo SELECT)", () => {
  it("puede hacer SELECT de una tabla creada por el admin después de migrar", async () => {
    const { rows } = await client(ro).query<{ label: string }>("SELECT label FROM probe");

    expect(rows).toEqual([{ label: "semilla" }]);
  });

  it.each([
    ["INSERT", "INSERT INTO probe (label) VALUES ('x')"],
    ["UPDATE", "UPDATE probe SET label = 'x'"],
    ["DELETE", "DELETE FROM probe"],
    ["CREATE TABLE", "CREATE TABLE ro_made (i int)"],
  ])("no puede hacer %s (42501)", async (_what, sql) => {
    await expect(client(ro).query(sql)).rejects.toMatchObject({ code: "42501" });
  });
});

describe("fleet_app (DML)", () => {
  it("puede hacer INSERT, SELECT, UPDATE y DELETE, y usar la secuencia del serial", async () => {
    const app_ = client(app);
    const inserted = await app_.query<{ id: number }>("INSERT INTO probe (label) VALUES ('desde app') RETURNING id");
    expect(inserted.rows[0]?.id).toBeGreaterThan(1);

    await app_.query("UPDATE probe SET label = 'editada' WHERE label = 'desde app'");
    const { rows } = await app_.query<{ label: string }>("SELECT label FROM probe WHERE label = 'editada'");
    expect(rows).toHaveLength(1);

    await app_.query("DELETE FROM probe WHERE label = 'editada'");
  });

  it.each([
    ["CREATE TABLE", "CREATE TABLE app_made (i int)"],
    ["CREATE SCHEMA", "CREATE SCHEMA app_schema"],
    ["DROP TABLE", "DROP TABLE probe"],
    ["CREATE ROLE", "CREATE ROLE sneaky"],
  ])("no puede hacer %s (42501)", async (_what, sql) => {
    await expect(client(app).query(sql)).rejects.toMatchObject({ code: "42501" });
  });

  it("no puede leer schema_migrations: no es parte del modelo de datos de la aplicación", async () => {
    await expect(client(app).query("SELECT * FROM schema_migrations")).rejects.toMatchObject({ code: "42501" });
  });
});
