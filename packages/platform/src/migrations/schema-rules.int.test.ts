import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../logger/logger.js";
import { integrationConfig as config } from "../testing/integration-support.js";
import { createTempDatabase, type TempDatabase } from "../testing/temp-database.js";
import { defaultMigrationsDir, migrate } from "./runner.js";

// Reglas de negocio del esquema de las migraciones 002 (tenants, vehículos, dispositivos), 003 (telemetría) y 004 (retención
// y un solo dispositivo activo por vehículo), sobre
// una base temporal con las migraciones reales. Los datos de cada test llevan UUID propios: no hay que limpiar entre
// tests. El test de ida y vuelta de rollback.int.test.ts cubre que los down dejen el esquema como estaba.
const rolePasswords = { fleet_app: config.FLEET_APP_PASSWORD, fleet_ro: config.FLEET_RO_PASSWORD };

let db: TempDatabase;
let admin: Client;
let app: Client;
let readOnly: Client;

async function connect(url: string): Promise<Client> {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

beforeAll(async () => {
  db = await createTempDatabase(config.DATABASE_ADMIN_URL);
  await migrate({
    adminUrl: db.adminUrl,
    migrationsDir: defaultMigrationsDir,
    rolePasswords,
    logger: createLogger({ service: "schema-rules-it", level: "error" }),
  });
  admin = await connect(db.adminUrl);
  // Los servicios usan fleet_app: las inserciones de los tests también, para comprobar sus permisos.
  app = await connect(db.urlFor("fleet_app", rolePasswords.fleet_app));
  readOnly = await connect(db.urlFor("fleet_ro", rolePasswords.fleet_ro));
});

afterAll(async () => {
  await Promise.all([admin?.end(), app?.end(), readOnly?.end()]);
  await db?.drop();
});

function sqlState(error: unknown): { code?: string; constraint?: string } {
  if (typeof error !== "object" || error === null) return {};
  return {
    ...("code" in error && typeof error.code === "string" && { code: error.code }),
    ...("constraint" in error && typeof error.constraint === "string" && { constraint: error.constraint }),
  };
}

/** Falla con el código SQLSTATE (y la constraint, si se pide) esperados. */
async function expectViolation(promise: Promise<unknown>, code: string, constraint?: string): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e ?? new Error("rechazado sin error"),
  );
  expect(error, "la sentencia debía fallar").toBeDefined();
  expect(sqlState(error)).toMatchObject({ code, ...(constraint !== undefined && { constraint }) });
}

async function insertTenant(name = `Flota ${randomUUID()}`): Promise<string> {
  const id = randomUUID();
  await app.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [id, name]);
  return id;
}

async function insertVehicle(tenantId: string, plate = `T${randomUUID().slice(0, 5).toUpperCase()}`): Promise<string> {
  const id = randomUUID();
  await app.query("INSERT INTO vehicles (id, tenant_id, plate) VALUES ($1, $2, $3)", [id, tenantId, plate]);
  return id;
}

const hashOf = () => randomUUID().replaceAll("-", "").repeat(2);

function insertDevice(tenantId: string, vehicleId: string, tokenHash = hashOf()) {
  return app.query("INSERT INTO devices (id, tenant_id, vehicle_id, token_hash) VALUES ($1, $2, $3, $4)", [
    randomUUID(),
    tenantId,
    vehicleId,
    tokenHash,
  ]);
}

describe("tenants, vehículos y dispositivos (002)", () => {
  it("el nombre del tenant es único", async () => {
    const name = `Flota ${randomUUID()}`;
    await insertTenant(name);

    await expectViolation(insertTenant(name), "23505", "tenants_name_key");
  });

  it("la placa es única dentro de un tenant, pero se puede repetir en otro", async () => {
    const [a, b] = [await insertTenant(), await insertTenant()];
    await insertVehicle(a, "ABC123");

    await expectViolation(insertVehicle(a, "ABC123"), "23505", "vehicles_tenant_plate_key");
    await expect(insertVehicle(b, "ABC123")).resolves.toEqual(expect.any(String));
  });

  it("un vehículo exige un tenant existente", async () => {
    await expectViolation(insertVehicle(randomUUID()), "23503", "vehicles_tenant_id_fkey");
  });

  it("la FK compuesta rechaza un dispositivo cuyo vehículo es de otro tenant", async () => {
    const [a, b] = [await insertTenant(), await insertTenant()];
    const vehicleOfA = await insertVehicle(a);

    // El tenant B existe y el vehículo existe, pero el par (vehículo, tenant B) no.
    await expectViolation(insertDevice(b, vehicleOfA), "23503", "devices_vehicle_tenant_fkey");
    await expect(insertDevice(a, vehicleOfA)).resolves.toMatchObject({ rowCount: 1 });
  });

  it("token_hash es único aunque el dispositivo anterior esté revocado, y solo acepta un sha256 en hexadecimal", async () => {
    const tenant = await insertTenant();
    const vehicle = await insertVehicle(tenant);
    const hash = hashOf();
    await insertDevice(tenant, vehicle, hash);
    await app.query("UPDATE devices SET revoked_at = now() WHERE token_hash = $1", [hash]);

    await expectViolation(insertDevice(tenant, vehicle, hash), "23505", "devices_token_hash_key");
    await expectViolation(insertDevice(tenant, vehicle, "fdt_el-token-en-claro"), "23514", "devices_token_hash_format");
    await expectViolation(insertDevice(tenant, vehicle, hash.toUpperCase()), "23514", "devices_token_hash_format");
  });

  it("la búsqueda por hash entre los no revocados devuelve la identidad y deja de encontrar el dispositivo al revocarlo", async () => {
    const tenant = await insertTenant();
    const vehicle = await insertVehicle(tenant);
    const hash = hashOf();
    await insertDevice(tenant, vehicle, hash);
    const lookup = "SELECT tenant_id, vehicle_id FROM devices WHERE token_hash = $1 AND revoked_at IS NULL";

    expect((await app.query(lookup, [hash])).rows).toEqual([{ tenant_id: tenant, vehicle_id: vehicle }]);

    await app.query("UPDATE devices SET revoked_at = now() WHERE token_hash = $1", [hash]);
    expect((await app.query(lookup, [hash])).rows).toEqual([]);
  });

  it("un vehículo admite un solo dispositivo activo (004): el segundo falla, y rotar (revocar y crear) sí funciona", async () => {
    const tenant = await insertTenant();
    const vehicle = await insertVehicle(tenant);
    const otherVehicle = await insertVehicle(tenant);
    await insertDevice(tenant, vehicle);

    await expectViolation(insertDevice(tenant, vehicle), "23505", "devices_one_active_per_vehicle_key");
    // Otro vehículo del mismo tenant tiene su propio dispositivo activo.
    await expect(insertDevice(tenant, otherVehicle)).resolves.toMatchObject({ rowCount: 1 });

    // Rotación: se revoca el activo y se crea el nuevo, en una transacción (como `pnpm device:token`).
    await app.query("BEGIN");
    await app.query("UPDATE devices SET revoked_at = now() WHERE vehicle_id = $1 AND revoked_at IS NULL", [vehicle]);
    await insertDevice(tenant, vehicle);
    await app.query("COMMIT");

    // Los revocados no cuentan: tras rotar hay dos dispositivos del vehículo y solo uno activo.
    const { rows } = await app.query<{ active: string; total: string }>(
      "SELECT count(*) FILTER (WHERE revoked_at IS NULL)::text AS active, count(*)::text AS total FROM devices WHERE vehicle_id = $1",
      [vehicle],
    );
    expect(rows).toEqual([{ active: "1", total: "2" }]);
  });

  it("fleet_ro lee pero no escribe", async () => {
    await expect(readOnly.query("SELECT count(*) FROM devices")).resolves.toBeDefined();
    await expectViolation(readOnly.query("INSERT INTO tenants (id, name) VALUES ($1, 'x')", [randomUUID()]), "42501");
  });
});

interface PointRow {
  eventId: string;
  tenantId: string;
  vehicleId: string;
  recordedAt: string;
  lon?: number;
  lat?: number;
}

/** Inserta como lo hará el processor: lote idempotente con ST_MakePoint(lon, lat). Devuelve cuántas filas entraron. */
async function insertPoint(point: PointRow): Promise<number> {
  const result = await app.query(
    `INSERT INTO telemetry (event_id, tenant_id, vehicle_id, device_id, recorded_at, received_at, geom, speed_mps, heading_deg, accuracy_m, altitude_m, mocked, low_accuracy)
     VALUES ($1, $2, $3, $4, $5::timestamptz, now(), ST_SetSRID(ST_MakePoint($6, $7), 4326), 12.5, 90, 8, NULL, false, false)
     ON CONFLICT DO NOTHING`,
    [point.eventId, point.tenantId, point.vehicleId, randomUUID(), point.recordedAt, point.lon ?? -75.5636, point.lat ?? 6.2518],
  );
  return result.rowCount ?? 0;
}

const daysAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

async function countPoints(tenantId: string, vehicleId: string): Promise<number> {
  const { rows } = await app.query<{ n: string }>(
    // Rango de tiempo siempre (regla 12): aquí, todo el pasado y el futuro cercano.
    "SELECT count(*)::text AS n FROM telemetry WHERE tenant_id = $1 AND vehicle_id = $2 AND recorded_at BETWEEN now() - interval '60 days' AND now() + interval '1 day'",
    [tenantId, vehicleId],
  );
  return Number(rows[0]?.n);
}

describe("telemetría (003)", () => {
  const ids = () => ({ tenantId: randomUUID(), vehicleId: randomUUID() });

  it("es una hypertable por recorded_at con chunks de 1 día", async () => {
    const { rows } = await admin.query<{ column_name: string; time_interval: string }>(
      "SELECT column_name, time_interval::text AS time_interval FROM timescaledb_information.dimensions WHERE hypertable_name = 'telemetry'",
    );

    expect(rows).toEqual([{ column_name: "recorded_at", time_interval: "1 day" }]);
  });

  it("guarda la geometría con SRID 4326 y longitud primero", async () => {
    const { tenantId, vehicleId } = ids();
    const eventId = randomUUID();
    await insertPoint({ eventId, tenantId, vehicleId, recordedAt: daysAgo(0.5), lon: -75.5636, lat: 6.2518 });

    const { rows } = await app.query<{ srid: number; x: number; y: number }>(
      "SELECT ST_SRID(geom) AS srid, ST_X(geom) AS x, ST_Y(geom) AS y FROM telemetry WHERE event_id = $1 AND recorded_at BETWEEN now() - interval '2 days' AND now()",
      [eventId],
    );

    expect(rows).toEqual([{ srid: 4326, x: -75.5636, y: 6.2518 }]);
  });

  it("el índice único hace no-op un insert duplicado (mismo eventId y mismo recordedAt)", async () => {
    const point = { eventId: randomUUID(), ...ids(), recordedAt: daysAgo(1) };

    expect(await insertPoint(point)).toBe(1);
    expect(await insertPoint(point)).toBe(0);

    expect(await countPoints(point.tenantId, point.vehicleId)).toBe(1);
  });

  it("caso límite documentado: el mismo eventId con distinto recordedAt son dos filas", async () => {
    const base = { eventId: randomUUID(), ...ids() };

    expect(await insertPoint({ ...base, recordedAt: daysAgo(1) })).toBe(1);
    expect(await insertPoint({ ...base, recordedAt: daysAgo(1.5) })).toBe(1);

    expect(await countPoints(base.tenantId, base.vehicleId)).toBe(2);
  });

  it("ON CONFLICT DO NOTHING sigue siendo idempotente sobre un chunk COMPRIMIDO (reenvío de un punto de hace días)", async () => {
    const { tenantId, vehicleId } = ids();
    const old = { eventId: randomUUID(), tenantId, vehicleId, recordedAt: daysAgo(20) };
    expect(await insertPoint(old)).toBe(1);

    // Se comprime el chunk del punto, como lo haría la política cuando cumple su antigüedad.
    const chunks = await admin.query<{ chunk: string; range_start: Date }>(
      `SELECT format('%I.%I', c.chunk_schema, c.chunk_name) AS chunk, c.range_start
       FROM timescaledb_information.chunks c
       WHERE c.hypertable_name = 'telemetry' AND c.range_start <= $1::timestamptz AND c.range_end > $1::timestamptz`,
      [old.recordedAt],
    );
    expect(chunks.rows).toHaveLength(1);
    await admin.query("SELECT compress_chunk($1::regclass, if_not_compressed => true)", [chunks.rows[0]?.chunk]);
    const compressed = await admin.query<{ is_compressed: boolean }>(
      "SELECT is_compressed FROM timescaledb_information.chunks WHERE hypertable_name = 'telemetry' AND range_start <= $1::timestamptz AND range_end > $1::timestamptz",
      [old.recordedAt],
    );
    expect(compressed.rows).toEqual([{ is_compressed: true }]);

    // El duplicado es un no-op; un punto nuevo en el mismo chunk comprimido sí entra.
    expect(await insertPoint(old)).toBe(0);
    const sameChunk = new Date((chunks.rows[0]?.range_start.getTime() ?? 0) + 60_000).toISOString();
    expect(await insertPoint({ ...old, eventId: randomUUID(), recordedAt: sameChunk })).toBe(1);
    expect(await countPoints(tenantId, vehicleId)).toBe(2);
  });

  it("declara la compresión a los 7 días y la retención a los 90 días (004)", async () => {
    const { rows } = await admin.query<{ proc_name: string; compress_after: string | null; drop_after: string | null }>(
      `SELECT proc_name, config ->> 'compress_after' AS compress_after, config ->> 'drop_after' AS drop_after
       FROM timescaledb_information.jobs WHERE hypertable_name = 'telemetry' ORDER BY proc_name`,
    );

    expect(rows).toEqual([
      { proc_name: "policy_compression", compress_after: "7 days", drop_after: null },
      { proc_name: "policy_retention", compress_after: null, drop_after: "90 days" },
    ]);
  });

  it("fleet_ro lee pero no inserta", async () => {
    await expect(readOnly.query("SELECT count(*) FROM telemetry WHERE recorded_at > now() - interval '1 day'")).resolves.toBeDefined();
    await expectViolation(
      readOnly.query(
        "INSERT INTO telemetry (event_id, tenant_id, vehicle_id, device_id, recorded_at, received_at, geom, mocked, low_accuracy) VALUES ($1, $2, $3, $4, now(), now(), ST_SetSRID(ST_MakePoint(-75, 6), 4326), false, false)",
        [randomUUID(), randomUUID(), randomUUID(), randomUUID()],
      ),
      "42501",
    );
  });

  it("rechaza una geometría fuera de SRID 4326 y un punto sin geometría", async () => {
    const insert = (geom: string) =>
      app.query(
        `INSERT INTO telemetry (event_id, tenant_id, vehicle_id, device_id, recorded_at, received_at, geom, mocked, low_accuracy)
         VALUES ($1, $2, $3, $4, now(), now(), ${geom}, false, false)`,
        [randomUUID(), randomUUID(), randomUUID(), randomUUID()],
      );

    await expectViolation(insert("ST_SetSRID(ST_MakePoint(500000, 600000), 3116)"), "22023");
    await expectViolation(insert("NULL"), "23502");
  });
});
