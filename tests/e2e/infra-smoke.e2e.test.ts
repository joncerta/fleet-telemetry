import { randomUUID } from "node:crypto";
import {
  createAdmin,
  createKafka,
  createLogger,
  createPool,
  createProducer,
  defaultMigrationsDir,
  getMigrationStatus,
  loadConfig,
  withCorrelationId,
} from "@fleet/platform";
import type { Admin } from "kafkajs";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { e2eConfigSchema } from "./support.js";

// Smoke de infraestructura contra el stack real (base `fleet`, tópicos reales), después de `pnpm db:migrate`.
// Solo lee, salvo los intentos de escritura que deben fallar; lo que cree por error lo limpia en afterAll.
const config = loadConfig(e2eConfigSchema);
const runId = randomUUID().replaceAll("-", "").slice(0, 8);
const logger = createLogger({ service: "e2e-infra-smoke", level: "error" });

const REAL_TOPICS = ["telemetry.raw", "telemetry.dlq", "vehicle.state", "fleet.alerts"];

let admin: Pool;
let readOnly: Pool;
let kafkaAdmin: Admin;
const kafka = createKafka({ brokers: config.KAFKA_BROKERS, clientId: `e2e-infra-smoke-${runId}`, logger });

beforeAll(async () => {
  admin = createPool({ connectionString: config.DATABASE_ADMIN_URL, applicationName: "e2e-admin", logger, max: 2 });
  readOnly = createPool({ connectionString: config.DATABASE_RO_URL, applicationName: "e2e-fleet-ro", logger, max: 2 });
  kafkaAdmin = createAdmin(kafka);
  await kafkaAdmin.connect();
});

afterAll(async () => {
  await admin.query(`DROP TABLE IF EXISTS public.e2e_ro_probe`);
  // Si el broker autocreó un tópico de las pruebas de arriba (las pruebas ya fallaron), no se deja basura en el stack.
  const leaked = (await kafkaAdmin.listTopics()).filter((topic) => topic.startsWith("fleet.e2e.") && topic.endsWith(`.${runId}`));
  if (leaked.length > 0) await kafkaAdmin.deleteTopics({ topics: leaked });
  await kafkaAdmin.disconnect();
  await Promise.all([admin.end(), readOnly.end()]);
});

function sqlState(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

describe("infraestructura de base de datos", () => {
  it("tiene instaladas las extensiones timescaledb y postgis", async () => {
    const { rows } = await admin.query<{ extname: string }>("SELECT extname FROM pg_extension WHERE extname = ANY($1::text[])", [
      ["timescaledb", "postgis"],
    ]);

    expect(rows.map((r) => r.extname).sort()).toEqual(["postgis", "timescaledb"]);
  });

  it("registró la migración 001 en schema_migrations (si falla, corre pnpm db:migrate)", async () => {
    const result = await admin
      .query<{ version: number; name: string; checksum: string }>("SELECT version, name, checksum FROM schema_migrations WHERE version = 1")
      .catch((error: unknown) => {
        if (sqlState(error) === "42P01") throw new Error("La base `fleet` no tiene schema_migrations: corre `pnpm db:migrate` antes del e2e.");
        throw error;
      });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ version: 1, name: "extensions_and_roles" });
    expect(result.rows[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("no deja migraciones pendientes ni discrepancias de checksum, y toda aplicada tiene registrado el de su down", async () => {
    const status = await getMigrationStatus({ adminUrl: config.DATABASE_ADMIN_URL, migrationsDir: defaultMigrationsDir, logger });

    expect(status.pending).toEqual([]);
    expect(status.discrepancies).toEqual([]);
    expect(status.applied.length).toBeGreaterThan(0);
    expect(status.applied.every((migration) => migration.downChecksumRegistered)).toBe(true);
  });

  it("deja fleet_app y fleet_ro con login y sin privilegios de administración", async () => {
    const { rows } = await admin.query<{ rolname: string; rolcanlogin: boolean; rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean }>(
      "SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname",
      [["fleet_app", "fleet_ro"]],
    );

    expect(rows).toEqual([
      { rolname: "fleet_app", rolcanlogin: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false },
      { rolname: "fleet_ro", rolcanlogin: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false },
    ]);
  });

  it("fleet_ro conecta con DATABASE_RO_URL y lee", async () => {
    const { rows } = await readOnly.query<{ who: string; extensions: string }>(
      "SELECT current_user AS who, count(*)::text AS extensions FROM pg_extension",
    );

    expect(rows[0]?.who).toBe("fleet_ro");
    expect(Number(rows[0]?.extensions)).toBeGreaterThanOrEqual(2);
  });

  it("fleet_ro no puede escribir: ni crear tablas ni insertar en schema_migrations (42501)", async () => {
    await expect(readOnly.query(`CREATE TABLE public.e2e_ro_probe (i int)`)).rejects.toMatchObject({ code: "42501" });
    await expect(
      readOnly.query("INSERT INTO schema_migrations (version, name, checksum) VALUES (9999, 'x', 'x')"),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

describe("infraestructura de Kafka", () => {
  it("existen los 4 tópicos del sistema", async () => {
    const topics = await kafkaAdmin.listTopics();

    expect(topics).toEqual(expect.arrayContaining(REAL_TOPICS));
  });

  it("el productor de la fábrica falla ante un tópico inexistente y no lo crea", async () => {
    const missing = `fleet.e2e.no-existe.${runId}`;
    // Pocos reintentos para que el fallo llegue rápido; la garantía de idempotencia no cambia.
    const producer = createProducer(kafka, { retry: { retries: 2, initialRetryTime: 100 } });
    await producer.connect();
    try {
      await expect(
        producer.send({ topic: missing, messages: [{ key: "veh-e2e", value: "{}", headers: withCorrelationId(undefined, `e2e-${runId}`) }] }),
      ).rejects.toThrow();
    } finally {
      await producer.disconnect();
    }

    expect(await kafkaAdmin.listTopics()).not.toContain(missing);
  });

  it("el broker no autocrea tópicos aunque el cliente lo pida (auto_create_topics_enabled desactivado)", async () => {
    const missing = `fleet.e2e.autocreate.${runId}`;
    // Cliente kafkajs directo, no el de la fábrica: este SÍ pide autocreación en la petición de metadatos, así que
    // solo la configuración del broker puede impedir que el tópico aparezca.
    const asking = kafka.producer({ allowAutoTopicCreation: true, retry: { retries: 1, initialRetryTime: 100 } });
    await asking.connect();
    try {
      await expect(asking.send({ topic: missing, messages: [{ key: "veh-e2e", value: "{}" }] })).rejects.toThrow();
    } finally {
      await asking.disconnect();
    }

    expect(await kafkaAdmin.listTopics()).not.toContain(missing);
  });
});
