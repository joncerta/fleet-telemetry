import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../logger/logger.js";
import { integrationConfig as config } from "../testing/integration-support.js";
import { createTempDatabase, type TempDatabase } from "../testing/temp-database.js";
import { checksumOf, loadMigrationFiles, MigrationError } from "./files.js";
import { defaultMigrationsDir, migrate } from "./runner.js";

const logger = createLogger({ service: "runner-it", level: "error" });
const REAL_001 = "001_extensions_and_roles.sql";
const REAL_001_DOWN = "001_extensions_and_roles.down.sql";
const rolePasswords = { fleet_app: config.FLEET_APP_PASSWORD, fleet_ro: config.FLEET_RO_PASSWORD };

let db: TempDatabase;
let dir: string;

beforeEach(async () => {
  db = await createTempDatabase(config.DATABASE_ADMIN_URL);
  dir = await mkdtemp(join(tmpdir(), "fleet-runner-it-"));
});

afterEach(async () => {
  await db.drop();
  await rm(dir, { recursive: true, force: true });
});

const run = (migrationsDir: string, withRoles = false, lockTimeoutMs?: number) =>
  migrate({
    adminUrl: db.adminUrl,
    migrationsDir,
    logger,
    ...(withRoles && { rolePasswords }),
    ...(lockTimeoutMs !== undefined && { lockTimeoutMs }),
  });

async function query<T extends Record<string, unknown>>(sql: string): Promise<T[]> {
  const client = new Client({ connectionString: db.adminUrl });
  await client.connect();
  try {
    return (await client.query<T>(sql)).rows;
  } finally {
    await client.end();
  }
}

const write = (name: string, sql: string) => writeFile(join(dir, name), sql);
/** Escribe el par up/down de una migración de prueba. */
const writePair = async (base: string, up: string, down: string) => {
  await write(`${base}.sql`, up);
  await write(`${base}.down.sql`, down);
};

describe("migrate con las migraciones reales", () => {
  it("aplica todas las migraciones reales (la 001 primero) y en la segunda corrida no hace nada", async () => {
    // El conjunto crece con cada fase: se compara contra los archivos del directorio, no contra un número fijo.
    const files = await loadMigrationFiles(defaultMigrationsDir);
    expect(files[0]).toMatchObject({ version: 1, name: "extensions_and_roles" });

    const first = await run(defaultMigrationsDir, true);

    expect(first.applied).toEqual(files.map((file) => ({ version: file.version, name: file.name })));
    expect(first.alreadyApplied).toBe(0);

    const extensions = await query<{ extname: string }>("SELECT extname FROM pg_extension");
    expect(extensions.map((e) => e.extname)).toEqual(expect.arrayContaining(["timescaledb", "postgis"]));

    const before = await query<{ version: number; name: string; checksum: string; applied_at: Date }>(
      "SELECT * FROM schema_migrations ORDER BY version",
    );
    const sql = await readFile(join(defaultMigrationsDir, REAL_001), "utf8");
    const downSql = await readFile(join(defaultMigrationsDir, REAL_001_DOWN), "utf8");
    expect(before).toHaveLength(files.length);
    expect(before[0]).toMatchObject({ version: 1, name: "extensions_and_roles", checksum: checksumOf(sql), down_checksum: checksumOf(downSql) });
    expect(before[0]?.applied_at).toBeInstanceOf(Date);

    const second = await run(defaultMigrationsDir, true);

    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toBe(files.length);
    const after = await query<{ version: number; applied_at: Date }>("SELECT version, applied_at FROM schema_migrations ORDER BY version");
    expect(after).toHaveLength(files.length);
    expect(after.map((row) => row.applied_at)).toEqual(before.map((row) => row.applied_at));
  });

  it("da login a fleet_app y fleet_ro con las contraseñas configuradas", async () => {
    await run(defaultMigrationsDir, true);

    const roles = await query<{ rolname: string; rolcanlogin: boolean }>(
      "SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname IN ('fleet_app', 'fleet_ro') ORDER BY rolname",
    );
    expect(roles).toEqual([
      { rolname: "fleet_app", rolcanlogin: true },
      { rolname: "fleet_ro", rolcanlogin: true },
    ]);

    for (const [role, password] of [
      ["fleet_app", rolePasswords.fleet_app],
      ["fleet_ro", rolePasswords.fleet_ro],
    ] as const) {
      const client = new Client({ connectionString: db.urlFor(role, password) });
      await client.connect();
      const { rows } = await client.query<{ who: string }>("SELECT current_user AS who");
      await client.end();
      expect(rows[0]?.who).toBe(role);
    }
  });
});

describe("migrate con migraciones de prueba", () => {
  it("dos migrate() concurrentes sobre la misma base aplican cada migración una sola vez", async () => {
    // Sin IF NOT EXISTS: si alguna migración corriera dos veces, el CREATE TABLE fallaría.
    // El pg_sleep mantiene el lock el tiempo suficiente para que la segunda corrida tenga que esperar.
    await writePair("001_create_marker", "SELECT pg_sleep(1); CREATE TABLE marker (id integer NOT NULL);", "DROP TABLE marker;");
    await writePair("002_fill_marker", "INSERT INTO marker (id) VALUES (1);", "DELETE FROM marker;");

    const [a, b] = await Promise.all([run(dir), run(dir)]);

    expect(a.applied.length + b.applied.length).toBe(2);
    expect(await query<{ n: string }>("SELECT count(*)::text AS n FROM marker")).toEqual([{ n: "1" }]);
    expect(await query("SELECT version FROM schema_migrations ORDER BY version")).toEqual([{ version: 1 }, { version: 2 }]);
  });

  it("falla con un mensaje claro si otra corrida tiene el lock y no lo suelta a tiempo", async () => {
    await writePair("001_one", "SELECT 1;", "SELECT 0;");
    const holder = new Client({ connectionString: db.adminUrl });
    await holder.connect();
    try {
      await holder.query("SELECT pg_advisory_lock(728000001::bigint)");

      await expect(run(dir, false, 400)).rejects.toThrow(/Otra instancia de db:migrate tiene el lock/);
    } finally {
      await holder.end();
    }

    // Liberado el lock, la corrida sigue funcionando.
    expect((await run(dir)).applied).toHaveLength(1);
  });

  it("falla si cambia el checksum de una migración ya aplicada, aunque no haya pendientes", async () => {
    await copyFile(join(defaultMigrationsDir, REAL_001), join(dir, REAL_001));
    await copyFile(join(defaultMigrationsDir, REAL_001_DOWN), join(dir, REAL_001_DOWN));
    await run(dir);
    const original = await readFile(join(dir, REAL_001), "utf8");

    await writeFile(join(dir, REAL_001), `${original}\n-- editada después de aplicarse\n`);

    const result = run(dir);
    await expect(result).rejects.toBeInstanceOf(MigrationError);
    await expect(result).rejects.toThrow(
      /checksum de 001_extensions_and_roles\.sql cambió.*Nunca se edita una migración existente/s,
    );
  });

  it("no considera cambio los saltos de línea CRLF de un checkout en Windows", async () => {
    await writePair("001_one", "SELECT 1;\nSELECT 2;\n", "SELECT 0;\nSELECT -1;\n");
    await run(dir);

    await writePair("001_one", "SELECT 1;\r\nSELECT 2;\r\n", "SELECT 0;\r\nSELECT -1;\r\n");

    const result = await run(dir);
    expect(result.applied).toEqual([]);
    expect(result.alreadyApplied).toBe(1);
  });

  it("falla si se borra o se renombra una migración aplicada", async () => {
    await writePair("001_one", "SELECT 1;", "SELECT 0;");
    await run(dir);

    await rm(join(dir, "001_one.sql"));
    await rm(join(dir, "001_one.down.sql"));
    await expect(run(dir)).rejects.toThrow(/001_one\.sql está aplicada pero ya no existe/);

    await writePair("001_uno", "SELECT 1;", "SELECT 0;");
    await expect(run(dir)).rejects.toThrow(/se aplicó como "one" y ahora se llama "uno"/);
  });

  it("falla si aparece una migración pendiente con número menor que la última aplicada", async () => {
    await writePair("002_two", "SELECT 2;", "SELECT 0;");
    await run(dir);

    await writePair("001_one", "SELECT 1;", "SELECT 0;");

    await expect(run(dir)).rejects.toThrow(/001_one\.sql tiene un número menor que la última aplicada \(2\)/);
  });

  it("revierte una migración que falla a la mitad y conserva las anteriores", async () => {
    await writePair("001_ok", "CREATE TABLE ok_table (i integer);", "DROP TABLE ok_table;");
    await writePair("002_bad", "CREATE TABLE half_done (i integer); SELECT 1 / 0;", "DROP TABLE half_done;");

    await expect(run(dir)).rejects.toThrow(/002_bad\.sql falló y se revirtió/);

    expect(await query("SELECT to_regclass('ok_table')::text AS t")).toEqual([{ t: "ok_table" }]);
    expect(await query("SELECT to_regclass('half_done')::text AS t")).toEqual([{ t: null }]);
    expect(await query("SELECT version FROM schema_migrations")).toEqual([{ version: 1 }]);
  });

  it("falla antes de tocar la base si hay números duplicados", async () => {
    await writePair("001_a", "CREATE TABLE a (i integer);", "DROP TABLE a;");
    await write("001_b.sql", "CREATE TABLE b (i integer);");

    await expect(run(dir)).rejects.toThrow(/duplicado 001/);

    expect(await query("SELECT to_regclass('schema_migrations')::text AS t")).toEqual([{ t: null }]);
  });
});
