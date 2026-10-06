import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../logger/logger.js";
import { integrationConfig as config } from "../testing/integration-support.js";
import { createTempDatabase, type TempDatabase } from "../testing/temp-database.js";
import { checksumOf, NO_TRANSACTION_MARKER } from "./files.js";
import { migrate, rollback } from "./runner.js";

// Migraciones sin transacción (`-- migrate:no-transaction`): el par de prueba usa CREATE INDEX CONCURRENTLY, que Postgres rechaza
// dentro de una transacción, así que solo pasa si el runner de verdad ejecuta fuera de una.
const logger = createLogger({ service: "no-transaction-it", level: "error" });
const MARK = NO_TRANSACTION_MARKER;

let db: TempDatabase;
let dir: string;

beforeEach(async () => {
  db = await createTempDatabase(config.DATABASE_ADMIN_URL);
  dir = await mkdtemp(join(tmpdir(), "fleet-no-tx-it-"));
});

afterEach(async () => {
  await db.drop();
  await rm(dir, { recursive: true, force: true });
});

const run = (lockTimeoutMs?: number) =>
  migrate({ adminUrl: db.adminUrl, migrationsDir: dir, logger, ...(lockTimeoutMs !== undefined && { lockTimeoutMs }) });
const back = () => rollback({ adminUrl: db.adminUrl, migrationsDir: dir, logger });

async function query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString: db.adminUrl });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

const writePair = async (base: string, up: string, down: string) => {
  await writeFile(join(dir, `${base}.sql`), up);
  await writeFile(join(dir, `${base}.down.sql`), down);
};
const exists = async (name: string) => (await query<{ present: boolean }>("SELECT to_regclass($1) IS NOT NULL AS present", [name]))[0]?.present === true;
const versions = () => query<{ version: number }>("SELECT version FROM schema_migrations ORDER BY version");

const UP = `${MARK}
CREATE TABLE IF NOT EXISTS nt_items (id integer NOT NULL, label text);
-- un punto y coma dentro de una cadena y de un DO no parte la sentencia; ni este comentario;
INSERT INTO nt_items (id, label) SELECT 1, 'a;b' WHERE NOT EXISTS (SELECT 1 FROM nt_items WHERE id = 1);
DO $$ BEGIN PERFORM 1; PERFORM 2; END $$;
CREATE INDEX CONCURRENTLY IF NOT EXISTS nt_items_id_idx ON nt_items (id);
`;
const DOWN = `${MARK}
DROP INDEX CONCURRENTLY IF EXISTS nt_items_id_idx;
DROP TABLE IF EXISTS nt_items;
`;

describe("migraciones sin transacción", () => {
  it("ejecuta fuera de una transacción (CREATE INDEX CONCURRENTLY pasa) y registra después del éxito, con los checksums", async () => {
    await writePair("001_nt", UP, DOWN);

    const result = await run();

    expect(result.applied).toEqual([{ version: 1, name: "nt" }]);
    expect(await exists("nt_items_id_idx")).toBe(true);
    expect(await query("SELECT label FROM nt_items")).toEqual([{ label: "a;b" }]);
    expect(await query("SELECT version, checksum, down_checksum FROM schema_migrations")).toEqual([
      { version: 1, checksum: checksumOf(UP), down_checksum: checksumOf(DOWN) },
    ]);
  });

  it("la misma sentencia dentro de una migración transaccional falla (el control: sin el marcador no habría prueba)", async () => {
    await writePair("001_tx", "CREATE TABLE nt_items (id integer);\nCREATE INDEX CONCURRENTLY nt_items_id_idx ON nt_items (id);", "DROP TABLE nt_items;");

    await expect(run()).rejects.toThrow(/001_tx\.sql falló y se revirtió/);
    expect(await exists("nt_items")).toBe(false);
  });

  it("repetir db:migrate no hace nada, y repetir el script tras un fallo a la mitad lo completa (idempotente sentencia por sentencia)", async () => {
    // La segunda sentencia falla: la primera queda hecha y no hay registro.
    const broken = `${MARK}\nCREATE TABLE IF NOT EXISTS nt_items (id integer NOT NULL, label text);\nSELECT 1 / 0;\nCREATE INDEX CONCURRENTLY IF NOT EXISTS nt_items_id_idx ON nt_items (id);\n`;
    await writePair("001_nt", broken, DOWN);

    await expect(run()).rejects.toThrow(/001_nt\.sql \(sin transacción\) falló y NO se revirtió/);
    expect(await exists("nt_items")).toBe(true);
    expect(await versions()).toEqual([]);

    // Se corrige el script (aún no está registrado, así que no hay checksum que lo impida) y se vuelve a correr: re-ejecuta todo.
    await writePair("001_nt", UP, DOWN);
    expect((await run()).applied).toEqual([{ version: 1, name: "nt" }]);
    expect(await exists("nt_items_id_idx")).toBe(true);
    expect(await versions()).toEqual([{ version: 1 }]);

    const again = await run();
    expect(again.applied).toEqual([]);
    expect(again.alreadyApplied).toBe(1);
  });

  it("respeta el advisory lock: con el lock tomado por otra sesión no ejecuta nada, y al soltarse aplica", async () => {
    await writePair("001_nt", UP, DOWN);
    const holder = new Client({ connectionString: db.adminUrl });
    await holder.connect();
    try {
      await holder.query("SELECT pg_advisory_lock(728000001::bigint)");

      await expect(run(400)).rejects.toThrow(/Otra instancia de db:migrate tiene el lock/);
      expect(await exists("nt_items")).toBe(false);
    } finally {
      await holder.end();
    }

    expect((await run()).applied).toHaveLength(1);
  });

  it("dos migrate() concurrentes la aplican una sola vez: la segunda espera el lock y la encuentra registrada", async () => {
    // El pg_sleep mantiene el lock el tiempo suficiente para que la segunda corrida tenga que esperar. Sin el lock, las dos la
    // ejecutarían y la segunda fallaría al registrar (clave duplicada en schema_migrations).
    await writePair("001_nt", `${MARK}\nSELECT pg_sleep(1);\nCREATE TABLE IF NOT EXISTS nt_items (id integer);`, `${MARK}\nDROP TABLE IF EXISTS nt_items;`);

    const [a, b] = await Promise.all([run(), run()]);

    expect(a.applied.length + b.applied.length).toBe(1);
    expect(await versions()).toEqual([{ version: 1 }]);
  });

  it("el down también corre sin transacción (DROP INDEX CONCURRENTLY) y borra la fila solo tras el éxito", async () => {
    await writePair("001_nt", UP, DOWN);
    await run();

    const result = await back();

    expect(result.reverted).toEqual([{ version: 1, name: "nt" }]);
    expect(await exists("nt_items_id_idx")).toBe(false);
    expect(await exists("nt_items")).toBe(false);
    expect(await versions()).toEqual([]);
  });

  it("si el down falla a la mitad, la migración sigue registrada como aplicada y repetirlo lo completa", async () => {
    // El down falla mientras exista una tabla externa (una causa transitoria): un down aplicado no se puede editar.
    const flakyDown = `${MARK}
DROP INDEX CONCURRENTLY IF EXISTS nt_items_id_idx;
DO $$ BEGIN IF to_regclass('nt_blocker') IS NOT NULL THEN RAISE EXCEPTION 'bloqueado por nt_blocker'; END IF; END $$;
DROP TABLE IF EXISTS nt_items;
`;
    await writePair("001_nt", UP, flakyDown);
    await run();
    await query("CREATE TABLE nt_blocker (id integer)");

    await expect(back()).rejects.toThrow(/\(sin transacción\) falló y NO se revirtió/);
    expect(await exists("nt_items_id_idx")).toBe(false);
    expect(await exists("nt_items")).toBe(true);
    expect(await versions()).toEqual([{ version: 1 }]);

    // Desaparece la causa y se repite: las sentencias ya hechas son no-ops y el resto se completa.
    await query("DROP TABLE nt_blocker");
    await back();
    expect(await exists("nt_items")).toBe(false);
    expect(await versions()).toEqual([]);
  });
});
