import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../logger/logger.js";
import { integrationConfig as config } from "../testing/integration-support.js";
import { createTempDatabase, type TempDatabase } from "../testing/temp-database.js";
import { withMigrationClient, type SessionTimeouts } from "./control.js";
import { checksumOf, loadMigrationFiles, MigrationError, type MigrationFile } from "./files.js";
import type { RollbackTarget } from "./rollback-target.js";
import { defaultMigrationsDir, getMigrationStatus, migrate, rollback, type RollbackOptions } from "./runner.js";

const logger = createLogger({ service: "rollback-it", level: "error" });
const rolePasswords = { fleet_app: config.FLEET_APP_PASSWORD, fleet_ro: config.FLEET_RO_PASSWORD };

let db: TempDatabase;
let other: TempDatabase | undefined;
let dir: string;

beforeEach(async () => {
  db = await createTempDatabase(config.DATABASE_ADMIN_URL);
  dir = await mkdtemp(join(tmpdir(), "fleet-rollback-it-"));
});

afterEach(async () => {
  await other?.drop();
  other = undefined;
  await db.drop();
  await rm(dir, { recursive: true, force: true });
});

const run = (migrationsDir: string, withRoles = false, sessionTimeouts?: Partial<SessionTimeouts>) =>
  migrate({ adminUrl: db.adminUrl, migrationsDir, logger, ...(withRoles && { rolePasswords }), ...(sessionTimeouts && { sessionTimeouts }) });

const backWith = (migrationsDir: string, extra: Partial<RollbackOptions>) =>
  rollback({ adminUrl: db.adminUrl, migrationsDir, logger, ...extra });

const back = (migrationsDir: string, target?: RollbackTarget, lockTimeoutMs?: number) =>
  rollback({
    adminUrl: db.adminUrl,
    migrationsDir,
    logger,
    ...(target && { target }),
    ...(lockTimeoutMs !== undefined && { lockTimeoutMs }),
  });

const status = (migrationsDir: string) => getMigrationStatus({ adminUrl: db.adminUrl, migrationsDir, logger });

/** Base temporal nueva: un test que prueba un fallo y su control positivo no puede reutilizar el estado a medias del primero. */
async function resetDatabase(): Promise<void> {
  await db.drop();
  db = await createTempDatabase(config.DATABASE_ADMIN_URL);
}

async function query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString: db.adminUrl });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

const write = (name: string, sql: string) => writeFile(join(dir, name), sql);

/** Escribe el par up/down de una migración de prueba. */
async function writePair(base: string, up: string, down: string): Promise<void> {
  await write(`${base}.sql`, up);
  await write(`${base}.down.sql`, down);
}

const versions = () => query<{ version: number }>("SELECT version FROM schema_migrations ORDER BY version");

async function tableExists(name: string): Promise<boolean> {
  const rows = await query<{ present: boolean }>("SELECT to_regclass($1) IS NOT NULL AS present", [name]);
  return rows[0]?.present === true;
}

/** Tres migraciones de prueba, cada una con su down: crean y borran una tabla. */
async function writeThree(): Promise<void> {
  for (const [n, name] of [
    ["001", "one"],
    ["002", "two"],
    ["003", "three"],
  ] as const) {
    await writePair(`${n}_${name}`, `CREATE TABLE t_${name} (i integer);`, `DROP TABLE t_${name};`);
  }
}

describe("rollback con migraciones de prueba", () => {
  it("por defecto revierte solo la última migración y borra su fila", async () => {
    await writeThree();
    await run(dir);

    const result = await back(dir);

    expect(result.reverted).toEqual([{ version: 3, name: "three" }]);
    expect(await versions()).toEqual([{ version: 1 }, { version: 2 }]);
    expect(await tableExists("t_three")).toBe(false);
    expect(await tableExists("t_two")).toBe(true);
  });

  it("con steps revierte de la más reciente a la más antigua", async () => {
    await writeThree();
    await run(dir);

    const result = await back(dir, { steps: 2 });

    expect(result.reverted).toEqual([
      { version: 3, name: "three" },
      { version: 2, name: "two" },
    ]);
    expect(await versions()).toEqual([{ version: 1 }]);
  });

  it("con to deja aplicada esa migración y revierte las posteriores; to 0 las revierte todas", async () => {
    await writeThree();
    await run(dir);

    expect((await back(dir, { to: 1 })).reverted.map((m) => m.version)).toEqual([3, 2]);
    expect(await versions()).toEqual([{ version: 1 }]);

    expect((await back(dir, { to: 0 })).reverted.map((m) => m.version)).toEqual([1]);
    expect(await versions()).toEqual([]);
    expect(await tableExists("schema_migrations")).toBe(true);
  });

  it("permite volver a aplicar lo revertido", async () => {
    await writeThree();
    await run(dir);
    await back(dir, { steps: 3 });

    const again = await run(dir);

    expect(again.applied.map((m) => m.version)).toEqual([1, 2, 3]);
  });

  it("falla con to si esa migración no está aplicada, sin tocar nada", async () => {
    await writeThree();
    await run(dir);

    await expect(back(dir, { to: 7 })).rejects.toThrow(/--to 7: esa migración no está aplicada/);

    expect(await versions()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
  });

  it("sin nada aplicado no hace nada (ni crea la tabla de control) y no falla", async () => {
    await writeThree();

    const result = await back(dir);

    expect(result.reverted).toEqual([]);
    expect(await tableExists("schema_migrations")).toBe(false);
  });

  it("con la tabla de control vacía tampoco hace nada", async () => {
    await writeThree();
    await run(dir);
    await back(dir, { to: 0 });

    expect((await back(dir)).reverted).toEqual([]);
  });

  it("con el checksum del down alterado falla sin tocar nada, aunque no sea la primera en revertirse", async () => {
    await writeThree();
    await run(dir);
    // 002 es la segunda en revertirse con steps 2: 003 tampoco debe ejecutarse.
    await write("002_two.down.sql", "DROP TABLE t_two; -- editado");

    const result = back(dir, { steps: 2 });

    await expect(result).rejects.toBeInstanceOf(MigrationError);
    await expect(result).rejects.toThrow(/checksum de 002_two\.down\.sql cambió.*ni su down/s);
    expect(await versions()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
    expect(await tableExists("t_three")).toBe(true);
    expect(await tableExists("t_two")).toBe(true);
  });

  it("con el checksum del up alterado falla sin tocar nada", async () => {
    await writeThree();
    await run(dir);
    await write("003_three.sql", "CREATE TABLE t_three (i integer); -- editado");

    await expect(back(dir)).rejects.toThrow(/checksum de 003_three\.sql cambió/);

    expect(await versions()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
    expect(await tableExists("t_three")).toBe(true);
  });

  it("falla si falta el archivo de una migración aplicada", async () => {
    await writeThree();
    await run(dir);
    await rm(join(dir, "003_three.sql"));
    await rm(join(dir, "003_three.down.sql"));

    await expect(back(dir)).rejects.toThrow(/003_three\.sql está aplicada pero ya no existe/);

    expect(await versions()).toHaveLength(3);
  });

  it("ejecuta cada down en su transacción: si falla, se revierte y la migración sigue aplicada", async () => {
    await writePair("001_ok", "CREATE TABLE ok_table (i integer);", "DROP TABLE ok_table;");
    await writePair("002_bad", "CREATE TABLE bad_table (i integer);", "DROP TABLE bad_table; SELECT 1 / 0;");
    await run(dir);

    await expect(back(dir, { steps: 2 })).rejects.toThrow(/002_bad\.down\.sql falló y se revirtió; la migración sigue aplicada/);

    expect(await versions()).toEqual([{ version: 1 }, { version: 2 }]);
    expect(await tableExists("bad_table")).toBe(true);
    expect(await tableExists("ok_table")).toBe(true);
  });

  it("si un down falla a mitad de varios, conserva lo ya revertido y lo demás sigue aplicado", async () => {
    await writePair("001_bad", "CREATE TABLE a_table (i integer);", "DROP TABLE a_table; SELECT 1 / 0;");
    await writePair("002_ok", "CREATE TABLE b_table (i integer);", "DROP TABLE b_table;");
    await run(dir);

    await expect(back(dir, { to: 0 })).rejects.toThrow(/001_bad\.down\.sql falló/);

    expect(await versions()).toEqual([{ version: 1 }]);
    expect(await tableExists("b_table")).toBe(false);
    expect(await tableExists("a_table")).toBe(true);
  });

  it("usa el mismo lock que migrate", async () => {
    await writeThree();
    await run(dir);
    const holder = new Client({ connectionString: db.adminUrl });
    await holder.connect();
    try {
      await holder.query("SELECT pg_advisory_lock(728000001::bigint)");

      await expect(back(dir, undefined, 400)).rejects.toThrow(/Otra instancia de db:migrate tiene el lock/);
    } finally {
      await holder.end();
    }

    expect(await versions()).toHaveLength(3);
  });

  it("rechaza un objetivo inválido antes de tocar la base", async () => {
    await writeThree();

    await expect(back(dir, { steps: 0 })).rejects.toThrow(/--steps/);

    expect(await tableExists("schema_migrations")).toBe(false);
  });
});

describe("schema_migrations de una base anterior a la reversibilidad", () => {
  /** Reproduce la base local `fleet`: tabla sin `down_checksum` y la 001 ya aplicada. */
  async function seedLegacyBase(): Promise<void> {
    await writePair("001_one", "CREATE TABLE t_one (i integer);", "DROP TABLE t_one;");
    const up = await readFile(join(dir, "001_one.sql"), "utf8");
    await query("CREATE TABLE t_one (i integer)");
    await query(
      "CREATE TABLE schema_migrations (version integer PRIMARY KEY, name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    await query("INSERT INTO schema_migrations (version, name, checksum) VALUES (1, 'one', $1)", [checksumOf(up)]);
  }

  it("migrate agrega la columna, registra el checksum del down y no vuelve a aplicar la migración", async () => {
    await seedLegacyBase();
    const before = await query<{ applied_at: Date }>("SELECT applied_at FROM schema_migrations");

    const first = await run(dir);

    expect(first.applied).toEqual([]);
    expect(first.alreadyApplied).toBe(1);
    expect(first.downChecksumsRegistered).toBe(1);
    const down = await readFile(join(dir, "001_one.down.sql"), "utf8");
    const after = await query<{ down_checksum: string; applied_at: Date }>("SELECT down_checksum, applied_at FROM schema_migrations");
    expect(after).toEqual([{ down_checksum: checksumOf(down), applied_at: before[0]?.applied_at }]);

    const second = await run(dir);
    expect(second.downChecksumsRegistered).toBe(0);
    expect(second.applied).toEqual([]);
  });

  it("no registra el down si el up de la migración cambió", async () => {
    await seedLegacyBase();
    await write("001_one.sql", "CREATE TABLE t_one (i integer); -- editado");

    await expect(run(dir)).rejects.toThrow(/checksum de 001_one\.sql cambió/);

    const rows = await query<{ down_checksum: string | null }>("SELECT down_checksum FROM schema_migrations");
    expect(rows).toEqual([{ down_checksum: null }]);
  });

  it("rollback también registra el down antes de validar y ejecutar", async () => {
    await seedLegacyBase();

    const result = await back(dir);

    expect(result.reverted).toEqual([{ version: 1, name: "one" }]);
    expect(await tableExists("t_one")).toBe(false);
    expect(await versions()).toEqual([]);
  });

  it("status lo lee sin alterar nada y marca el down sin registrar", async () => {
    await seedLegacyBase();

    const result = await status(dir);

    expect(result.applied).toMatchObject([{ version: 1, name: "one", downChecksumRegistered: false }]);
    expect(result.pending).toEqual([]);
    expect(result.discrepancies).toEqual([]);
    const column = await query("SELECT 1 FROM pg_attribute WHERE attrelid = 'schema_migrations'::regclass AND attname = 'down_checksum'");
    expect(column).toEqual([]);
  });
});

describe("getMigrationStatus", () => {
  it("en una base sin migrar lista todo como pendiente y no crea nada", async () => {
    await writeThree();

    const result = await status(dir);

    expect(result.applied).toEqual([]);
    expect(result.pending.map((m) => m.version)).toEqual([1, 2, 3]);
    expect(result.discrepancies).toEqual([]);
    expect(await tableExists("schema_migrations")).toBe(false);
  });

  it("lista aplicadas y pendientes", async () => {
    await writeThree();
    await run(dir);
    await back(dir);

    const result = await status(dir);

    expect(result.applied.map((m) => [m.version, m.downChecksumRegistered])).toEqual([
      [1, true],
      [2, true],
    ]);
    expect(result.applied[0]?.appliedAt).toBeInstanceOf(Date);
    expect(result.pending).toEqual([{ version: 3, name: "three" }]);
    expect(result.discrepancies).toEqual([]);
  });

  it("devuelve, sin lanzar, la discrepancia de checksum del up y del down", async () => {
    await writeThree();
    await run(dir);
    await write("001_one.sql", "CREATE TABLE t_one (i integer); -- editado");
    await write("002_two.down.sql", "DROP TABLE t_two; -- editado");

    const result = await status(dir);

    expect(result.discrepancies).toHaveLength(2);
    expect(result.discrepancies[0]).toMatch(/checksum de 001_one\.sql cambió/);
    expect(result.discrepancies[1]).toMatch(/checksum de 002_two\.down\.sql cambió/);
  });

  it("marca como discrepancia una migración aplicada que desapareció", async () => {
    await writePair("002_two", "SELECT 2;", "SELECT 0;");
    await run(dir);
    await writePair("001_one", "SELECT 1;", "SELECT 0;");
    await rm(join(dir, "002_two.sql"));
    await rm(join(dir, "002_two.down.sql"));

    const result = await status(dir);

    expect(result.discrepancies.join("\n")).toMatch(/002_two\.sql está aplicada pero ya no existe/);
    expect(result.discrepancies.join("\n")).toMatch(/001_one\.sql tiene un número menor que la última aplicada \(2\)/);
  });
});


// --- Ida y vuelta -----------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;

/** Esquemas internos de Timescale: se excluyen del snapshot junto con los de Postgres. */
const TIMESCALE_SCHEMAS = [
  "_timescaledb_internal",
  "_timescaledb_functions",
  "_timescaledb_catalog",
  "_timescaledb_cache",
  "_timescaledb_config",
  "timescaledb_information",
  "timescaledb_experimental",
];

/**
 * Relaciones (tablas, vistas, secuencias, índices...) que cuentan para el snapshot. Alias `c` (pg_class) y `n`
 * (pg_namespace). Fuera: catálogos de Postgres, esquemas internos de Timescale, objetos que pertenecen a una
 * extensión (\`pg_depend\` con \`deptype = 'e'\`) y la tabla de control del runner (\`schema_migrations\` y su índice), que
 * ningún down borra a propósito; sus filas se comparan aparte.
 */
const USER_RELATION = `
  n.nspname NOT IN ('pg_catalog', 'information_schema', ${TIMESCALE_SCHEMAS.map((s) => `'${s}'`).join(", ")})
  AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'
  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
  AND c.oid IS DISTINCT FROM to_regclass('public.schema_migrations')
  AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid = c.oid AND i.indrelid = to_regclass('public.schema_migrations'))`;

/**
 * Esquemas (de usuario o de Postgres) cuyos objetos no cuentan: los catálogos, los de Timescale, los TOAST y los temporales.
 * Alias `n` (pg_namespace).
 */
const USER_SCHEMA = `
  n.nspname NOT IN ('pg_catalog', 'information_schema', ${TIMESCALE_SCHEMAS.map((s) => `'${s}'`).join(", ")})
  AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'`;

/**
 * Los continuous aggregates guardan ids numéricos en su definición (la hypertable materializada, las vistas parcial y directa y
 * la marca de agua) que cambian al recrearlos. Se normalizan para comparar la definición y no el id.
 */
const normalizeViewDefinition = (expr: string): string =>
  `regexp_replace(regexp_replace(${expr}, '(_materialized_hypertable|_partial_view|_direct_view)_[0-9]+', '\\1_N', 'g'), 'cagg_watermark\\([0-9]+\\)', 'cagg_watermark(N)', 'g')`;

/**
 * Si la hypertable de `alias` (una vista de `timescaledb_information` con `hypertable_schema` y `hypertable_name`) es la
 * materializada de un continuous aggregate, se traduce a la vista del usuario: el nombre `_materialized_hypertable_N` lleva un
 * id que cambia al recrear. Devuelve el LEFT JOIN a `timescaledb_information.continuous_aggregates` con alias `ca`.
 */
const TARGET_JOIN = (alias: string): string =>
  `LEFT JOIN timescaledb_information.continuous_aggregates ca
     ON ca.materialization_hypertable_schema = ${alias}.hypertable_schema AND ca.materialization_hypertable_name = ${alias}.hypertable_name`;

interface SchemaSnapshot {
  extensions: Row[];
  roles: Row[];
  schemas: Row[];
  relations: Row[];
  columns: Row[];
  constraints: Row[];
  indexes: Row[];
  routines: Row[];
  views: Row[];
  triggers: Row[];
  types: Row[];
  databaseGrants: Row[];
  schemaGrants: Row[];
  defaultAcls: Row[];
  tableGrants: Row[];
  hypertables: Row[];
  dimensions: Row[];
  compressionSettings: Row[];
  continuousAggregates: Row[];
  jobs: Row[];
}

/**
 * Estado del esquema de la base bajo prueba. Los roles se comparan por nombre: son del cluster y sobreviven al down
 * mientras otra base los use (guarda 2BP01), pero su LOGIN lo da \`migrate\`, no la migración.
 */
async function snapshot(): Promise<SchemaSnapshot> {
  const timescale = (await query("SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'")).length > 0;
  return {
    extensions: await query("SELECT extname FROM pg_extension WHERE extname <> 'plpgsql' ORDER BY extname"),
    roles: await query("SELECT rolname FROM pg_roles WHERE rolname IN ('fleet_app', 'fleet_ro') ORDER BY rolname"),
    // Esquemas de usuario distintos de `public`. Los de una extensión (deptype 'e') no cuentan.
    schemas: await query(
      `SELECT n.nspname AS name FROM pg_namespace n
       WHERE ${USER_SCHEMA} AND n.nspname <> 'public'
         AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_namespace'::regclass AND d.objid = n.oid AND d.deptype = 'e')
       ORDER BY 1`,
    ),
    relations: await query(
      `SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS kind
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE ${USER_RELATION} ORDER BY 1, 2`,
    ),
    columns: await query(
      `SELECT c.relname AS "table", a.attname AS "column", format_type(a.atttypid, a.atttypmod) AS type,
              a.attnotnull AS not_null, pg_get_expr(d.adbin, d.adrelid) AS "default"
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND ${USER_RELATION}
       ORDER BY c.relname, a.attnum`,
    ),
    constraints: await query(
      `SELECT c.relname AS "table", k.conname AS name, pg_get_constraintdef(k.oid) AS definition
       FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND ${USER_RELATION} ORDER BY 1, 2`,
    ),
    indexes: await query(
      `SELECT pg_get_indexdef(i.indexrelid) AS definition
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND ${USER_RELATION} ORDER BY 1`,
    ),
    // Funciones y procedimientos de cualquier esquema de usuario, con el md5 de su definición completa (cuerpo, volatilidad, atributos):
    // un `CREATE OR REPLACE` que el down no restaura cambia el md5 aunque el nombre y los argumentos sigan iguales. Los agregados no
    // admiten `pg_get_functiondef`: de esos solo cuenta la firma.
    routines: await query(
      `SELECT n.nspname AS schema, p.proname AS name, pg_get_function_identity_arguments(p.oid) AS args,
              CASE WHEN p.prokind = 'a' THEN NULL ELSE md5(pg_get_functiondef(p.oid)) END AS definition_md5
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE ${USER_SCHEMA}
         AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
       ORDER BY 1, 2, 3`,
    ),
    // Vistas, vistas materializadas y continuous aggregates (que son vistas): su definición, no solo su nombre y sus columnas.
    views: await query(
      `SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS kind,
              ${normalizeViewDefinition("pg_get_viewdef(c.oid, true)")} AS definition
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('v', 'm') AND ${USER_RELATION} ORDER BY 1, 2`,
    ),
    // Triggers de usuario (sin los internos de las FK).
    triggers: await query(
      `SELECT n.nspname AS schema, c.relname AS "table", t.tgname AS name, pg_get_triggerdef(t.oid, true) AS definition
       FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE NOT t.tgisinternal AND ${USER_RELATION} ORDER BY 1, 2, 3`,
    ),
    types: await query(
      `SELECT t.typname AS name, t.typtype::text AS kind
       FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = 'public' AND t.typtype IN ('e', 'd')
         AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e')
       ORDER BY 1`,
    ),
    // Grants explícitos a los roles (has_*_privilege no sirve: PUBLIC ya tiene CONNECT y USAGE por defecto).
    databaseGrants: await query(
      `SELECT g.rolname, a.privilege_type
       FROM pg_database d, aclexplode(d.datacl) a JOIN pg_roles g ON g.oid = a.grantee
       WHERE d.datname = current_database() AND g.rolname IN ('fleet_app', 'fleet_ro') ORDER BY g.rolname, a.privilege_type`,
    ),
    schemaGrants: await query(
      `SELECT g.rolname, a.privilege_type
       FROM pg_namespace n, aclexplode(n.nspacl) a JOIN pg_roles g ON g.oid = a.grantee
       WHERE n.nspname = 'public' AND g.rolname IN ('fleet_app', 'fleet_ro') ORDER BY g.rolname, a.privilege_type`,
    ),
    defaultAcls: await query(
      `SELECT a.defaclobjtype::text AS kind, a.defaclacl::text AS acl
       FROM pg_default_acl a JOIN pg_namespace n ON n.oid = a.defaclnamespace
       WHERE n.nspname = 'public' ORDER BY a.defaclobjtype`,
    ),
    tableGrants: await query(
      `SELECT n.nspname AS schema, c.relname AS name, g.rolname AS role, a.privilege_type AS privilege
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(c.relacl) a
       JOIN pg_roles g ON g.oid = a.grantee
       WHERE g.rolname IN ('fleet_app', 'fleet_ro') AND ${USER_RELATION} ORDER BY 1, 2, 3, 4`,
    ),
    // Lo de Timescale solo si la extensión está instalada. Se omiten los ids numéricos (cambian al recrear) y la hypertable
    // materializada de un continuous aggregate se traduce a su vista (`TARGET_JOIN`).
    hypertables: timescale
      ? await query(
          `SELECT COALESCE(ca.view_schema, h.hypertable_schema) AS schema, COALESCE(ca.view_name, h.hypertable_name) AS name,
                  h.num_dimensions, h.compression_enabled
           FROM timescaledb_information.hypertables h ${TARGET_JOIN("h")} ORDER BY 1, 2`,
        )
      : [],
    // Dimensiones: el intervalo de chunk (`set_chunk_time_interval`) y las particiones de cada hypertable.
    dimensions: timescale
      ? await query(
          `SELECT COALESCE(ca.view_schema, h.hypertable_schema) AS schema, COALESCE(ca.view_name, h.hypertable_name) AS name,
                  h.dimension_number, h.column_name, h.column_type::text AS column_type, h.dimension_type,
                  h.time_interval::text AS time_interval, h.integer_interval::text AS integer_interval, h.num_partitions
           FROM timescaledb_information.dimensions h ${TARGET_JOIN("h")} ORDER BY 1, 2, 3`,
        )
      : [],
    // Ajustes de compresión: segmentby y orderby por columna.
    compressionSettings: timescale
      ? await query(
          `SELECT COALESCE(ca.view_schema, h.hypertable_schema) AS schema, COALESCE(ca.view_name, h.hypertable_name) AS name,
                  h.attname, h.segmentby_column_index, h.orderby_column_index, h.orderby_asc, h.orderby_nullsfirst
           FROM timescaledb_information.compression_settings h ${TARGET_JOIN("h")} ORDER BY 1, 2, 3`,
        )
      : [],
    continuousAggregates: timescale
      ? await query(
          `SELECT view_schema AS schema, view_name AS name, hypertable_schema AS source_schema, hypertable_name AS source_name,
                  materialized_only, compression_enabled
           FROM timescaledb_information.continuous_aggregates ORDER BY 1, 2`,
        )
      : [],
    // Jobs de usuario (id >= 1000). La config se normaliza: sin `hypertable_id` ni `mat_hypertable_id` (ids que cambian al
    // recrear) y con la hypertable materializada traducida a su vista.
    jobs: timescale
      ? await query(
          `SELECT j.proc_schema, j.proc_name, COALESCE(ca.view_schema, j.hypertable_schema) AS target_schema,
                  COALESCE(ca.view_name, j.hypertable_name) AS target_name, j.schedule_interval::text AS schedule_interval,
                  (j.config - 'hypertable_id' - 'mat_hypertable_id')::text AS config
           FROM timescaledb_information.jobs j ${TARGET_JOIN("j")} WHERE j.job_id >= 1000 ORDER BY 1, 2, 3, 4`,
        )
      : [],
  };
}

const controlRows = () => query("SELECT version, name, checksum, down_checksum FROM schema_migrations ORDER BY version");

/** Una segunda base con la 001 aplicada: los roles del cluster tienen dependencias ajenas y el down los conserva. */
async function createOtherDatabaseUsingRoles(): Promise<void> {
  other = await createTempDatabase(config.DATABASE_ADMIN_URL);
  await migrate({ adminUrl: other.adminUrl, migrationsDir: defaultMigrationsDir, logger });
}

/**
 * Ida y vuelta de las migraciones de \`sourceDir\` en la base temporal:
 * 1. baseline antes del primer up;
 * 2. up de una en una, con un snapshot tras cada una;
 * 3. down de una en una: cada estado debe ser idéntico al snapshot previo al up de esa migración (así un down que
 *    deja una columna, un índice o un grant no queda tapado por el DROP TABLE de una migración anterior);
 * 4. tras el down completo, el estado es igual al baseline;
 * 5. tras el segundo up, el estado y las filas de control son iguales a los del primero.
 * Lanza (con el diff del snapshot) si cualquiera de las comparaciones falla.
 */
async function roundTrip(sourceDir: string, withRoles: boolean): Promise<void> {
  const files = await loadMigrationFiles(sourceDir);
  expect(files.length).toBeGreaterThan(0);
  // Directorio de trabajo propio: las migraciones se copian de a una, así que `sourceDir` no se aplica de golpe.
  const work = await mkdtemp(join(tmpdir(), "fleet-roundtrip-"));
  try {
    await roundTripIn(work, files, withRoles);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function roundTripIn(work: string, files: readonly MigrationFile[], withRoles: boolean): Promise<void> {

  const baseline = await snapshot();
  const states: SchemaSnapshot[] = [baseline];
  for (const file of files) {
    await writeFile(join(work, file.fileName), file.sql);
    await writeFile(join(work, file.downFileName), file.downSql);
    const result = await run(work, withRoles);
    expect(result.applied.map((m) => m.version)).toEqual([file.version]);
    states.push(await snapshot());
  }
  const firstUp = { schema: states[files.length], control: await controlRows() };
  expect(firstUp.control).toHaveLength(files.length);
  expect(firstUp.control.every((row) => typeof row.down_checksum === "string")).toBe(true);

  // `states[i]` es el estado previo al up de `files[i]`: se indexa por posición, no por número de versión (001, 003, 004...).
  for (const { file, before } of files.map((file, i) => ({ file, before: states[i] })).reverse()) {
    const result = await back(work, { steps: 1 });
    expect(result.reverted).toEqual([{ version: file.version, name: file.name }]);
    expect(await snapshot(), `estado tras revertir ${file.downFileName}`).toEqual(before);
  }
  expect(await controlRows()).toEqual([]);
  expect(await snapshot(), "estado tras el down completo contra el baseline").toEqual(baseline);

  const secondUp = await run(work, withRoles);
  expect(secondUp.applied.map((m) => m.version)).toEqual(files.map((f) => f.version));
  expect({ schema: await snapshot(), control: await controlRows() }).toEqual(firstUp);
}

describe("ida y vuelta de las migraciones reales", () => {
  it("el down completo vuelve al baseline y el segundo up reproduce el primero; los roles sobreviven mientras otra base los use", async () => {
    await createOtherDatabaseUsingRoles();

    await roundTrip(defaultMigrationsDir, true);

    // Con las migraciones reales hay algo que comparar: las extensiones y los grants de la 001.
    const [first] = await loadMigrationFiles(defaultMigrationsDir);
    expect(first?.version).toBe(1);
    const afterUp = await snapshot();
    expect(afterUp.extensions.length).toBeGreaterThanOrEqual(2);
    expect(afterUp.databaseGrants).toHaveLength(2);
    expect(afterUp.schemaGrants).toHaveLength(2);
    expect(afterUp.defaultAcls.length).toBeGreaterThan(0);
    expect(afterUp.roles).toHaveLength(2);
    // Los roles siguen funcionando tras la vuelta.
    const client = new Client({ connectionString: db.urlFor("fleet_ro", rolePasswords.fleet_ro) });
    await client.connect();
    await client.end();
  });
});

describe("el test de ida y vuelta detecta un down incompleto", () => {
  /** Una migración correcta: tabla, columna con default, constraint, índice, función, tipo y grant, y su down completo. */
  const GOOD_UP = [
    "CREATE TABLE IF NOT EXISTS good (id integer PRIMARY KEY, label text NOT NULL DEFAULT 'x');",
    "CREATE INDEX good_label_idx ON good (label);",
    "ALTER TABLE good ADD CONSTRAINT good_label_len CHECK (length(label) < 50);",
    "CREATE TYPE good_kind AS ENUM ('a', 'b');",
    "CREATE FUNCTION good_fn() RETURNS integer LANGUAGE sql AS 'SELECT 1';",
    "GRANT SELECT ON good TO fleet_ro;",
  ].join("\n");
  const GOOD_DOWN = ["DROP FUNCTION good_fn();", "DROP TYPE good_kind;", "DROP TABLE good;"].join("\n");

  it("acepta un par completo (control positivo: el test no falla siempre)", async () => {
    await createOtherDatabaseUsingRoles();
    await writePair("001_good", GOOD_UP, GOOD_DOWN);

    await roundTrip(dir, false);
  });

  it("falla si el down deja una tabla", async () => {
    await writePair("001_leaky", "CREATE TABLE leaky (i integer);", "SELECT 1;");

    await expect(roundTrip(dir, false)).rejects.toThrow(/estado tras revertir 001_leaky.down.sql/);
  });

  it("falla si el down de una migración posterior deja una columna (el DROP TABLE de la anterior no lo tapa)", async () => {
    await writePair("001_base", "CREATE TABLE base (i integer);", "DROP TABLE base;");
    await writePair("002_col", "ALTER TABLE base ADD COLUMN extra text;", "SELECT 1;");

    await expect(roundTrip(dir, false)).rejects.toThrow(/estado tras revertir 002_col\.down\.sql/);
  });

  it("falla si el down deja un índice", async () => {
    await writePair("001_base", "CREATE TABLE base (i integer);", "DROP TABLE base;");
    await writePair("002_idx", "CREATE INDEX base_i_idx ON base (i);", "SELECT 1;");

    await expect(roundTrip(dir, false)).rejects.toThrow(/estado tras revertir 002_idx.down.sql/);
  });

  it("falla si el down deja un grant a un rol", async () => {
    await createOtherDatabaseUsingRoles();
    await writePair("001_base", "CREATE TABLE base (i integer);", "DROP TABLE base;");
    await writePair("002_grant", "GRANT SELECT ON base TO fleet_ro;", "SELECT 1;");

    await expect(roundTrip(dir, false)).rejects.toThrow(/estado tras revertir 002_grant.down.sql/);
  });

  it("falla si el down deja una función", async () => {
    await writePair("001_fn", "CREATE FUNCTION leaky_fn() RETURNS integer LANGUAGE sql AS 'SELECT 1';", "SELECT 1;");

    await expect(roundTrip(dir, false)).rejects.toThrow(/estado tras revertir 001_fn.down.sql/);
  });

  it("falla si el down deja un tipo", async () => {
    await writePair("001_kind", "CREATE TYPE leaky_kind AS ENUM ('a');", "SELECT 1;");

    await expect(roundTrip(dir, false)).rejects.toThrow(/estado tras revertir 001_kind\.down\.sql/);
  });

  it("compara por posición, no por número de versión: con 001 y 003 detecta el down incompleto de la 003", async () => {
    await writePair("001_base", "CREATE TABLE base (i integer);", "DROP TABLE base;");
    await writePair("003_col", "ALTER TABLE base ADD COLUMN extra text;", "SELECT 1;");

    await expect(roundTrip(dir, false)).rejects.toThrow(/estado tras revertir 003_col\.down\.sql/);
  });

  it("con versiones no consecutivas acepta pares completos (control positivo)", async () => {
    await writePair("001_base", "CREATE TABLE base (i integer);", "DROP TABLE base;");
    await writePair("003_col", "ALTER TABLE base ADD COLUMN extra text;", "ALTER TABLE base DROP COLUMN extra;");
    await writePair("004_idx", "CREATE INDEX base_i_idx ON base (i);", "DROP INDEX base_i_idx;");

    await roundTrip(dir, false);
  });

  // H2: el snapshot compara DEFINICIONES, no solo nombres. Cada caso tiene su control positivo (el down que sí restaura pasa).
  it("falla si el down no restaura una función reemplazada (mismo nombre y argumentos, otro cuerpo)", async () => {
    await writePair("001_fn", "CREATE FUNCTION swapped_fn() RETURNS integer LANGUAGE sql AS 'SELECT 1';", "DROP FUNCTION swapped_fn();");
    const replace = "CREATE OR REPLACE FUNCTION swapped_fn() RETURNS integer LANGUAGE sql AS 'SELECT 2';";
    await writePair("002_replace", replace, "SELECT 1;");

    await expect(roundTrip(dir, false)).rejects.toThrow(/estado tras revertir 002_replace\.down\.sql/);
  });

  it("acepta el down que restaura la función reemplazada (control positivo)", async () => {
    await writePair("001_fn", "CREATE FUNCTION swapped_fn() RETURNS integer LANGUAGE sql AS 'SELECT 1';", "DROP FUNCTION swapped_fn();");
    await writePair(
      "002_replace",
      "CREATE OR REPLACE FUNCTION swapped_fn() RETURNS integer LANGUAGE sql AS 'SELECT 2';",
      "CREATE OR REPLACE FUNCTION swapped_fn() RETURNS integer LANGUAGE sql AS 'SELECT 1';",
    );

    await roundTrip(dir, false);
  });

  it("falla si el down no restaura una función cuyo atributo cambió (volatilidad), aunque el cuerpo sea el mismo", async () => {
    await writePair("001_fn", "CREATE FUNCTION attr_fn() RETURNS integer LANGUAGE sql AS 'SELECT 1';", "DROP FUNCTION attr_fn();");
    await writePair("002_attr", "ALTER FUNCTION attr_fn() IMMUTABLE;", "SELECT 1;");

    await expect(roundTrip(dir, false)).rejects.toThrow(/estado tras revertir 002_attr\.down\.sql/);
  });

  it("falla si el down no restaura una vista reemplazada, y acepta el que sí (control positivo)", async () => {
    await writePair("001_view", "CREATE VIEW swapped_view AS SELECT 1 AS n;", "DROP VIEW swapped_view;");
    await writePair("002_replace", "CREATE OR REPLACE VIEW swapped_view AS SELECT 2 AS n;", "SELECT 1;");
    await expect(roundTrip(dir, false)).rejects.toThrow(/estado tras revertir 002_replace\.down\.sql/);

    await resetDatabase();
    await writePair("002_replace", "CREATE OR REPLACE VIEW swapped_view AS SELECT 2 AS n;", "CREATE OR REPLACE VIEW swapped_view AS SELECT 1 AS n;");
    await roundTrip(dir, false);
  });

  it("falla si el down deja una vista materializada", async () => {
    await writePair("001_base", "CREATE TABLE base (i integer);", "DROP TABLE base;");
    await writePair("002_matview", "CREATE MATERIALIZED VIEW base_mv AS SELECT i FROM base;", "SELECT 1;");

    await expect(roundTrip(dir, false)).rejects.toThrow(/estado tras revertir 002_matview\.down\.sql/);
  });

  it("falla si el down deja un trigger, y acepta el que lo quita (control positivo)", async () => {
    await writePair(
      "001_base",
      [
        "CREATE TABLE base (i integer);",
        "CREATE FUNCTION base_trg() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END';",
      ].join("\n"),
      "DROP TABLE base; DROP FUNCTION base_trg();",
    );
    const trigger = "CREATE TRIGGER base_audit BEFORE INSERT ON base FOR EACH ROW EXECUTE FUNCTION base_trg();";
    await writePair("002_trigger", trigger, "SELECT 1;");
    await expect(roundTrip(dir, false)).rejects.toThrow(/estado tras revertir 002_trigger\.down\.sql/);

    await resetDatabase();
    await writePair("002_trigger", trigger, "DROP TRIGGER base_audit ON base;");
    await roundTrip(dir, false);
  });

  it("falla si el down deja un esquema de usuario, y acepta el que lo borra (control positivo)", async () => {
    await writePair("001_schema", "CREATE SCHEMA leaky_schema;", "SELECT 1;");
    await expect(roundTrip(dir, false)).rejects.toThrow(/estado tras revertir 001_schema\.down\.sql/);

    await resetDatabase();
    await writePair("001_schema", "CREATE SCHEMA leaky_schema;", "DROP SCHEMA leaky_schema;");
    await roundTrip(dir, false);
  });

  it("falla si el down deja una función en un esquema que no es public", async () => {
    await writePair("001_schema", "CREATE SCHEMA other_schema;", "DROP SCHEMA other_schema CASCADE;");
    await writePair("002_fn", "CREATE FUNCTION other_schema.o_fn() RETURNS integer LANGUAGE sql AS 'SELECT 1';", "SELECT 1;");

    await expect(roundTrip(dir, false)).rejects.toThrow(/estado tras revertir 002_fn\.down\.sql/);
  });

  describe("con TimescaleDB (la 001 real, que instala las extensiones)", () => {
    /** Copia la 001 real al directorio de prueba y deja viva otra base que use los roles (el down de la 001 los conserva). */
    async function withRealFirstMigration(): Promise<void> {
      await createOtherDatabaseUsingRoles();
      for (const name of ["001_extensions_and_roles.sql", "001_extensions_and_roles.down.sql"]) {
        await writeFile(join(dir, name), await readFile(join(defaultMigrationsDir, name), "utf8"));
      }
    }
    const HYPERTABLE_UP = [
      "CREATE TABLE ts_data (t timestamptz NOT NULL, v integer NOT NULL, label text NOT NULL DEFAULT 'x');",
      "SELECT create_hypertable('ts_data', 't', chunk_time_interval => INTERVAL '1 day');",
    ].join("\n");

    it("falla si el down no restaura el intervalo de chunk, y acepta el que sí (control positivo)", async () => {
      await withRealFirstMigration();
      await writePair("002_ts", HYPERTABLE_UP, "DROP TABLE ts_data;");
      const change = "SELECT set_chunk_time_interval('ts_data', INTERVAL '6 hours');";
      await writePair("003_interval", change, "SELECT 1;");
      await expect(roundTrip(dir, false)).rejects.toThrow(/estado tras revertir 003_interval\.down\.sql/);

      await resetDatabase();
      await writePair("003_interval", change, "SELECT set_chunk_time_interval('ts_data', INTERVAL '1 day');");
      await roundTrip(dir, false);
    });

    it("falla si el down no restaura los ajustes de compresión (segmentby y orderby)", async () => {
      await withRealFirstMigration();
      await writePair("002_ts", HYPERTABLE_UP, "DROP TABLE ts_data;");
      await writePair(
        "003_compress",
        "ALTER TABLE ts_data SET (timescaledb.compress, timescaledb.compress_segmentby = 'label', timescaledb.compress_orderby = 't DESC');",
        "SELECT 1;",
      );

      await expect(roundTrip(dir, false)).rejects.toThrow(/estado tras revertir 003_compress\.down\.sql/);
    });

    it("falla si el down no quita una política (un job de usuario), y acepta el que sí (control positivo)", async () => {
      await withRealFirstMigration();
      await writePair("002_ts", HYPERTABLE_UP, "DROP TABLE ts_data;");
      const policy = "SELECT add_retention_policy('ts_data', INTERVAL '30 days');";
      await writePair("003_retention", policy, "SELECT 1;");
      await expect(roundTrip(dir, false)).rejects.toThrow(/estado tras revertir 003_retention\.down\.sql/);

      await resetDatabase();
      await writePair("003_retention", policy, "SELECT remove_retention_policy('ts_data');");
      await roundTrip(dir, false);
    });

    /** Continuous aggregate con datos y política de refresco: lo que traerá la 007. No cabe en una transacción (`WITH DATA`). */
    const CAGG_UP = `-- migrate:no-transaction
CREATE TABLE IF NOT EXISTS cg_raw (t timestamptz NOT NULL, v integer NOT NULL);
SELECT create_hypertable('cg_raw', 't', if_not_exists => TRUE);
CREATE MATERIALIZED VIEW IF NOT EXISTS cg_hourly WITH (timescaledb.continuous) AS
  SELECT time_bucket('1 hour', t) AS bucket, sum(v) AS total FROM cg_raw GROUP BY 1 WITH DATA;
SELECT add_continuous_aggregate_policy('cg_hourly', start_offset => INTERVAL '3 hours', end_offset => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour', if_not_exists => TRUE);
`;
    const CAGG_DOWN = `-- migrate:no-transaction
DROP MATERIALIZED VIEW IF EXISTS cg_hourly;
DROP TABLE IF EXISTS cg_raw;
`;

    it("un continuous aggregate (vista, hypertable materializada y política) hace la ida y vuelta: los ids que cambian al recrearlo no cuentan", async () => {
      await withRealFirstMigration();
      await writePair("002_cagg", CAGG_UP, CAGG_DOWN);

      await roundTrip(dir, false);

      const state = await snapshot();
      expect(state.continuousAggregates).toHaveLength(1);
      expect(state.views.map((v) => v.name)).toEqual(["cg_hourly"]);
      expect(state.views[0]?.definition).toMatch(/_materialized_hypertable_N/);
      expect(state.jobs).toEqual([expect.objectContaining({ proc_name: "policy_refresh_continuous_aggregate", target_name: "cg_hourly" })]);
      expect(String((state.jobs[0] as { config: string }).config)).not.toMatch(/hypertable_id/);
    });

    it("falla si el down no revierte un cambio de un continuous aggregate (materialized_only)", async () => {
      await withRealFirstMigration();
      await writePair("002_cagg", CAGG_UP, CAGG_DOWN);
      await writePair(
        "003_realtime",
        "-- migrate:no-transaction\nALTER MATERIALIZED VIEW cg_hourly SET (timescaledb.materialized_only = false);\n",
        "-- migrate:no-transaction\nSELECT 1;\n",
      );

      await expect(roundTrip(dir, false)).rejects.toThrow(/estado tras revertir 003_realtime\.down\.sql/);
    });
  });

  it("falla si el up deja un default privilege que el down no revierte", async () => {
    await createOtherDatabaseUsingRoles();
    await writePair("001_acl", "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO fleet_ro;", "SELECT 1;");

    await expect(roundTrip(dir, false)).rejects.toThrow(/estado tras revertir 001_acl.down.sql/);
  });
});

describe("guarda de roles del down de la 001", () => {
  it("falla si queda un grant olvidado a fleet_app en la base actual, y la migración sigue aplicada", async () => {
    await migrate({ adminUrl: db.adminUrl, migrationsDir: defaultMigrationsDir, logger });
    // Un grant que ninguna migración conoce: el down de la 001 no lo revoca.
    await query("CREATE TABLE forgotten (i integer)");
    await query("GRANT SELECT ON forgotten TO fleet_app");

    await expect(back(defaultMigrationsDir, { to: 0 })).rejects.toThrow(/fleet_app todavía tiene \d+ dependencia\(s\) en la base/);

    expect(await versions()).toEqual([{ version: 1 }]);
    expect((await query("SELECT extname FROM pg_extension WHERE extname = 'postgis'")).length).toBe(1);
  });

  it("falla también por un grant olvidado a fleet_ro", async () => {
    await migrate({ adminUrl: db.adminUrl, migrationsDir: defaultMigrationsDir, logger });
    await query("CREATE TABLE forgotten_ro (i integer)");
    await query("GRANT SELECT ON forgotten_ro TO fleet_ro");
    // Los privilegios por defecto ya le dieron la tabla a fleet_app: se quitan para que solo quede fleet_ro.
    await query("REVOKE ALL ON forgotten_ro FROM fleet_app");

    await expect(back(defaultMigrationsDir, { to: 0 })).rejects.toThrow(/fleet_ro todavía tiene/);
  });

  it("no falla cuando las únicas dependencias son de otras bases: conserva los roles", async () => {
    await createOtherDatabaseUsingRoles();
    await migrate({ adminUrl: db.adminUrl, migrationsDir: defaultMigrationsDir, logger });

    const result = await back(defaultMigrationsDir, { to: 0 });

    // Todas las reales, de la más reciente a la 001 (el conjunto crece con cada fase).
    const files = await loadMigrationFiles(defaultMigrationsDir);
    expect(result.reverted).toEqual([...files].reverse().map((file) => ({ version: file.version, name: file.name })));
    expect(result.reverted.at(-1)).toEqual({ version: 1, name: "extensions_and_roles" });
    expect(await query("SELECT rolname FROM pg_roles WHERE rolname IN ('fleet_app', 'fleet_ro') ORDER BY rolname")).toEqual([
      { rolname: "fleet_app" },
      { rolname: "fleet_ro" },
    ]);
  });
});

describe("marca de entorno local del servidor (fleet.environment)", () => {
  const environment = async () => (await query<{ value: string | null }>("SELECT current_setting('fleet.environment', true) AS value"))[0]?.value;
  /** `ALTER DATABASE` solo sobre la base temporal (su nombre sale del patrón de `createTempDatabase`), nunca sobre `fleet`. */
  const markTemporaryDatabaseAs = (value: string) => query(`ALTER DATABASE "${db.name}" SET fleet.environment = '${value}'`);

  it("la base temporal hereda la marca del servidor y el rollback pasa", async () => {
    await writeThree();
    await run(dir);
    expect(await environment()).toBe("local");

    const result = await back(dir);

    expect(result.reverted).toEqual([{ version: 3, name: "three" }]);
  });

  it("con otra marca se niega, con o sin dryRun, y no toca la base", async () => {
    await writeThree();
    await run(dir);
    await markTemporaryDatabaseAs("remote");
    expect(await environment()).toBe("remote");

    await expect(back(dir)).rejects.toBeInstanceOf(MigrationError);
    await expect(back(dir)).rejects.toThrow(/marcada como local.*marcada como "remote"/s);
    await expect(backWith(dir, { dryRun: true })).rejects.toThrow(/marcada como local/);

    expect(await versions()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
    expect(await tableExists("t_three")).toBe(true);
  });

  it("con la marca vacía también se niega", async () => {
    await writeThree();
    await run(dir);
    await markTemporaryDatabaseAs("");

    await expect(back(dir)).rejects.toThrow(/sin marca/);
    expect(await versions()).toHaveLength(3);
  });
});

describe("dry run del rollback", () => {
  it("muestra qué revertiría, en orden, sin tocar la base", async () => {
    await writeThree();
    await run(dir);
    const before = await query("SELECT version, name, checksum, down_checksum, applied_at FROM schema_migrations ORDER BY version");

    const result = await backWith(dir, { target: { to: 1 }, dryRun: true });

    expect(result.reverted).toEqual([]);
    expect(result.wouldRevert).toEqual([
      { version: 3, name: "three" },
      { version: 2, name: "two" },
    ]);
    expect(await tableExists("t_three")).toBe(true);
    expect(await tableExists("t_two")).toBe(true);
    expect(await query("SELECT version, name, checksum, down_checksum, applied_at FROM schema_migrations ORDER BY version")).toEqual(before);
  });

  it("valida los checksums igual que el rollback real", async () => {
    await writeThree();
    await run(dir);
    await write("003_three.down.sql", "DROP TABLE t_three; -- editado");

    await expect(backWith(dir, { dryRun: true })).rejects.toThrow(/checksum de 003_three\.down\.sql cambió/);
  });

  it("no registra el checksum del down de una base anterior a la reversibilidad ni crea la columna", async () => {
    await writePair("001_one", "CREATE TABLE t_one (i integer);", "DROP TABLE t_one;");
    const up = await readFile(join(dir, "001_one.sql"), "utf8");
    await query("CREATE TABLE t_one (i integer)");
    await query(
      "CREATE TABLE schema_migrations (version integer PRIMARY KEY, name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    await query("INSERT INTO schema_migrations (version, name, checksum) VALUES (1, 'one', $1)", [checksumOf(up)]);

    const result = await backWith(dir, { dryRun: true });

    expect(result.wouldRevert).toEqual([{ version: 1, name: "one" }]);
    expect(await query("SELECT 1 FROM pg_attribute WHERE attrelid = 'schema_migrations'::regclass AND attname = 'down_checksum'")).toEqual([]);
    expect(await tableExists("t_one")).toBe(true);
  });

  it("sin nada aplicado no devuelve nada ni crea la tabla de control", async () => {
    await writeThree();

    const result = await backWith(dir, { dryRun: true });

    expect(result.wouldRevert).toEqual([]);
    expect(await tableExists("schema_migrations")).toBe(false);
  });

  it("no toma el advisory lock: se puede planear mientras otra corrida lo tiene", async () => {
    await writeThree();
    await run(dir);
    const holder = new Client({ connectionString: db.adminUrl });
    await holder.connect();
    try {
      await holder.query("SELECT pg_advisory_lock(728000001::bigint)");

      const result = await backWith(dir, { dryRun: true, lockTimeoutMs: 200 });

      expect(result.wouldRevert).toHaveLength(1);
    } finally {
      await holder.end();
    }
  });
});

describe("tiempos de la sesión de migración", () => {
  const show = (name: string, timeouts?: Partial<SessionTimeouts>) =>
    withMigrationClient(
      db.adminUrl,
      logger,
      async (client) => (await client.query<{ value: string }>("SELECT current_setting($1) AS value", [name])).rows[0]?.value,
      timeouts ? { timeouts: { lockTimeoutMs: 8_000, idleInTransactionTimeoutMs: 60_000, ...timeouts } } : {},
    );

  it("por defecto fija lock_timeout en 8 s e idle_in_transaction_session_timeout en 1 min", async () => {
    expect(await show("lock_timeout")).toBe("8s");
    expect(await show("idle_in_transaction_session_timeout")).toBe("1min");
  });

  it("acepta valores configurados", async () => {
    expect(await show("lock_timeout", { lockTimeoutMs: 300 })).toBe("300ms");
    expect(await show("idle_in_transaction_session_timeout", { idleInTransactionTimeoutMs: 2_000 })).toBe("2s");
  });

  it("cierra una sesión inactiva dentro de una transacción", async () => {
    // Logger propio para leer el error que Postgres envía al cerrar la sesión (`withMigrationClient` lo registra).
    const lines: string[] = [];
    const capturing = createLogger({ service: "idle-it", level: "error", destination: { write: (line) => void lines.push(line) } });
    const outcome = withMigrationClient(
      db.adminUrl,
      capturing,
      async (client) => {
        await client.query("BEGIN");
        // Sin más consultas: Postgres debe terminar la sesión por inactividad. Se espera por polling, no con un sleep fijo.
        const deadline = Date.now() + 10_000;
        for (;;) {
          const rows = await query<{ n: string }>(
            "SELECT count(*)::text AS n FROM pg_stat_activity WHERE application_name = 'fleet-db-migrate' AND datname = current_database() AND state = 'idle in transaction'",
          );
          if (rows[0]?.n === "0") break;
          if (Date.now() > deadline) throw new Error("La sesión inactiva no se cerró a tiempo");
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return client.query("SELECT 1");
      },
      { timeouts: { lockTimeoutMs: 8_000, idleInTransactionTimeoutMs: 300 } },
    );

    // El rechazo no puede ser el error de polling del propio test ("La sesión inactiva no se cerró a tiempo"), que un
    // `toThrow()` sin patrón también aceptaría: tiene que ser el de la conexión ya cerrada por el servidor, y el log
    // de la conexión tiene que traer el error de Postgres 25P03 (idle_in_transaction_session_timeout).
    const failure = await outcome.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    const message = failure instanceof Error ? failure.message : "";
    expect(message).not.toMatch(/no se cerró a tiempo/);
    expect(message).toMatch(/connection error|Connection terminated/i);
    const logged = lines.map((line) => JSON.parse(line) as { err?: { code?: string; message?: string } });
    expect(logged.map((entry) => entry.err?.code)).toContain("25P03");
    expect(logged.map((entry) => entry.err?.message)).toContain("terminating connection due to idle-in-transaction timeout");
  });

  it("si una migración espera un lock más que lock_timeout, falla, se revierte y pide reintentar en una ventana de menos carga", async () => {
    await writePair("001_lt", "CREATE TABLE lt (i integer);", "DROP TABLE lt;");
    await run(dir);
    await writePair("002_alter", "ALTER TABLE lt ADD COLUMN c integer;", "ALTER TABLE lt DROP COLUMN c;");
    const holder = new Client({ connectionString: db.adminUrl });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("LOCK TABLE lt IN ACCESS EXCLUSIVE MODE");

      const failure = run(dir, false, { lockTimeoutMs: 300 });

      await expect(failure).rejects.toBeInstanceOf(MigrationError);
      await expect(failure).rejects.toThrow(/002_alter\.sql falló y se revirtió/);
      await expect(failure).rejects.toThrow(/300 ms.*Reintenta en una ventana de menos carga/s);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await holder.end();
    }

    expect(await versions()).toEqual([{ version: 1 }]);
    // Liberado el lock, el mismo comando funciona.
    expect((await run(dir)).applied.map((m) => m.version)).toEqual([2]);
  });

  it("lo mismo en un down: la migración sigue aplicada y el mensaje pide reintentar", async () => {
    await writePair("001_lt", "CREATE TABLE lt (i integer);", "DROP TABLE lt;");
    await run(dir);
    const holder = new Client({ connectionString: db.adminUrl });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("LOCK TABLE lt IN ACCESS EXCLUSIVE MODE");

      await expect(backWith(dir, { sessionTimeouts: { lockTimeoutMs: 300 } })).rejects.toThrow(
        /001_lt\.down\.sql falló.*Reintenta en una ventana de menos carga/s,
      );
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await holder.end();
    }

    expect(await versions()).toEqual([{ version: 1 }]);
  });
});
