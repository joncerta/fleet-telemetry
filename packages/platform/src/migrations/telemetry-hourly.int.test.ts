import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../logger/logger.js";
import { integrationConfig as config } from "../testing/integration-support.js";
import { createTempDatabase, type TempDatabase } from "../testing/temp-database.js";
import { defaultMigrationsDir, migrate } from "./runner.js";

// Reglas de negocio de la migración 009 (continuous aggregate `telemetry_hourly`) sobre una base temporal con las migraciones reales:
// los agregados coinciden con el cálculo directo, un punto tardío dentro de la ventana de refresco se refleja tras el siguiente
// refresco, la hora en curso sale en tiempo real y los permisos son de solo lectura. La ida y vuelta del esquema la cubre
// rollback.int.test.ts (compara definiciones de continuous aggregates y la config de sus jobs).
const rolePasswords = { fleet_app: config.FLEET_APP_PASSWORD, fleet_ro: config.FLEET_RO_PASSWORD };
const HOUR_MS = 3_600_000;

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
    logger: createLogger({ service: "telemetry-hourly-it", level: "error" }),
  });
  admin = await connect(db.adminUrl);
  await admin.query("SET TIME ZONE 'UTC'");
  app = await connect(db.urlFor("fleet_app", rolePasswords.fleet_app));
  readOnly = await connect(db.urlFor("fleet_ro", rolePasswords.fleet_ro));
});

afterAll(async () => {
  await Promise.all([admin?.end(), app?.end(), readOnly?.end()]);
  await db?.drop();
});

interface PointSpec {
  recordedAt: Date;
  speedMps: number | null;
  mocked?: boolean;
  lowAccuracy?: boolean;
}

async function insertPoints(tenantId: string, vehicleId: string, points: readonly PointSpec[]): Promise<void> {
  await admin.query(
    `INSERT INTO telemetry (event_id, tenant_id, vehicle_id, device_id, recorded_at, received_at, geom, speed_mps, mocked, low_accuracy)
     SELECT gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, t.recorded_at, t.recorded_at + interval '2 seconds',
            ST_SetSRID(ST_MakePoint(-74.07, 4.71), 4326), t.speed_mps, t.mocked, t.low_accuracy
     FROM unnest($4::timestamptz[], $5::float8[], $6::boolean[], $7::boolean[]) AS t(recorded_at, speed_mps, mocked, low_accuracy)`,
    [
      tenantId,
      vehicleId,
      randomUUID(),
      points.map((p) => p.recordedAt.toISOString()),
      points.map((p) => p.speedMps),
      points.map((p) => p.mocked ?? false),
      points.map((p) => p.lowAccuracy ?? false),
    ],
  );
}

const hourStart = (offsetHours: number): Date => new Date(Math.floor(Date.now() / HOUR_MS) * HOUR_MS - offsetHours * HOUR_MS);

/** Refresca hasta el inicio de la hora en curso (lo que cubre `end_offset = 1 hour`). */
async function refresh(): Promise<void> {
  await admin.query("CALL refresh_continuous_aggregate('telemetry_hourly', NULL, $1::timestamptz)", [hourStart(0).toISOString()]);
}

interface Hourly {
  bucket: string;
  points: number;
  avg: number | null;
  max: number | null;
  mocked: number;
  low: number;
}

/** bigint llega como string desde pg: se convierte de forma explícita. */
function toHourly(rows: Record<string, unknown>[]): Hourly[] {
  return rows.map((r) => ({
    bucket: new Date(String(r.bucket)).toISOString(),
    points: Number(r.points),
    avg: r.avg === null ? null : Number(r.avg),
    max: r.max === null ? null : Number(r.max),
    mocked: Number(r.mocked),
    low: Number(r.low),
  }));
}

const fromView = async (tenantId: string, vehicleId: string, until = hourStart(0)): Promise<Hourly[]> =>
  toHourly(
    (
      await admin.query<Record<string, unknown>>(
        `SELECT bucket::text, points, avg_speed_mps AS avg, max_speed_mps AS max, mocked_points AS mocked, low_accuracy_points AS low
         FROM telemetry_hourly WHERE tenant_id = $1 AND vehicle_id = $2 AND bucket < $3::timestamptz ORDER BY bucket`,
        [tenantId, vehicleId, until.toISOString()],
      )
    ).rows,
  );

const direct = async (tenantId: string, vehicleId: string, until = hourStart(0)): Promise<Hourly[]> =>
  toHourly(
    (
      await admin.query<Record<string, unknown>>(
        `SELECT time_bucket('1 hour', recorded_at)::text AS bucket, count(*) AS points, avg(speed_mps) AS avg, max(speed_mps) AS max,
                count(*) FILTER (WHERE mocked) AS mocked, count(*) FILTER (WHERE low_accuracy) AS low
         FROM telemetry WHERE tenant_id = $1 AND vehicle_id = $2 AND recorded_at >= $3::timestamptz AND recorded_at < $4::timestamptz
         GROUP BY 1 ORDER BY 1`,
        [tenantId, vehicleId, new Date(until.getTime() - 72 * HOUR_MS).toISOString(), until.toISOString()],
      )
    ).rows,
  );

describe("telemetry_hourly (009)", () => {
  it("tras refrescar, los agregados por hora coinciden con el cálculo directo", async () => {
    const tenantId = randomUUID();
    const vehicleId = randomUUID();
    const h = hourStart(30);
    await insertPoints(tenantId, vehicleId, [
      { recordedAt: new Date(h.getTime() + 60_000), speedMps: 10 },
      { recordedAt: new Date(h.getTime() + 120_000), speedMps: 20, mocked: true },
      { recordedAt: new Date(h.getTime() + 180_000), speedMps: null, lowAccuracy: true },
      { recordedAt: new Date(h.getTime() + HOUR_MS + 5_000), speedMps: 4 },
      { recordedAt: new Date(h.getTime() + 2 * HOUR_MS + 5_000), speedMps: 0, mocked: true, lowAccuracy: true },
      { recordedAt: new Date(h.getTime() + 2 * HOUR_MS + 65_000), speedMps: 8 },
    ]);

    await refresh();

    const expected = await direct(tenantId, vehicleId);
    expect(expected).toHaveLength(3);
    expect(expected[0]).toMatchObject({ points: 3, max: 20, mocked: 1, low: 1 });
    expect(expected[0]?.avg).toBeCloseTo(15);
    const actual = await fromView(tenantId, vehicleId);
    expect(actual).toHaveLength(expected.length);
    actual.forEach((row, i) => {
      const want = expected[i];
      expect(row).toMatchObject({ bucket: want?.bucket, points: want?.points, max: want?.max, mocked: want?.mocked, low: want?.low });
      expect(row.avg).toBeCloseTo(want?.avg ?? Number.NaN);
    });
  });

  it("un punto tardío dentro de la ventana de refresco se refleja tras el siguiente refresco, no antes", async () => {
    const tenantId = randomUUID();
    const vehicleId = randomUUID();
    const h = hourStart(30);
    await insertPoints(tenantId, vehicleId, [{ recordedAt: new Date(h.getTime() + 60_000), speedMps: 10 }]);
    await refresh();
    expect((await fromView(tenantId, vehicleId))[0]).toMatchObject({ points: 1, max: 10 });

    // Llega tarde (cola offline): su hora de fix cae en un bucket que ya estaba materializado.
    await insertPoints(tenantId, vehicleId, [{ recordedAt: new Date(h.getTime() + 600_000), speedMps: 30, mocked: true }]);

    expect((await fromView(tenantId, vehicleId))[0]).toMatchObject({ points: 1, max: 10, mocked: 0 });
    await refresh();
    expect((await fromView(tenantId, vehicleId))[0]).toMatchObject({ points: 2, max: 30, mocked: 1 });
    expect(await fromView(tenantId, vehicleId)).toHaveLength((await direct(tenantId, vehicleId)).length);
  });

  it("la hora en curso sale en tiempo real, sin esperar al refresco", async () => {
    const tenantId = randomUUID();
    const vehicleId = randomUUID();
    await refresh();
    await insertPoints(tenantId, vehicleId, [{ recordedAt: new Date(hourStart(0).getTime() + 1_000), speedMps: 7 }]);

    const rows = await fromView(tenantId, vehicleId, new Date(hourStart(0).getTime() + HOUR_MS));

    expect(rows).toEqual([expect.objectContaining({ points: 1, max: 7 })]);
  });

  it("separa los tenants: el agregado de uno no incluye los puntos de otro", async () => {
    const [tenantA, tenantB, vehicleA, vehicleB] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const h = hourStart(29);
    await insertPoints(tenantA, vehicleA, [{ recordedAt: new Date(h.getTime() + 1_000), speedMps: 1 }]);
    await insertPoints(tenantB, vehicleB, [{ recordedAt: new Date(h.getTime() + 2_000), speedMps: 2 }, { recordedAt: new Date(h.getTime() + 3_000), speedMps: 3 }]);

    await refresh();

    expect(await fromView(tenantA, vehicleB)).toEqual([]);
    expect((await fromView(tenantA, vehicleA))[0]?.points).toBe(1);
    expect((await fromView(tenantB, vehicleB))[0]?.points).toBe(2);
  });

  it("la política de refresco cubre los puntos tardíos de 7 días y corre cada 15 minutos; hay retención de 90 días", async () => {
    const { rows } = await admin.query<{ proc_name: string; schedule_interval: string; start_offset: string | null; end_offset: string | null; drop_after: string | null }>(
      `SELECT j.proc_name, j.schedule_interval::text AS schedule_interval, j.config->>'start_offset' AS start_offset,
              j.config->>'end_offset' AS end_offset, j.config->>'drop_after' AS drop_after
       FROM timescaledb_information.jobs j
       JOIN timescaledb_information.continuous_aggregates ca
         -- Según la versión, jobs nombra la política de un agregado por su vista o por su hypertable materializada.
         ON (j.hypertable_schema, j.hypertable_name) IN ((ca.view_schema, ca.view_name), (ca.materialization_hypertable_schema, ca.materialization_hypertable_name))
       WHERE ca.view_name = 'telemetry_hourly' ORDER BY j.proc_name`,
    );

    const refreshJob = rows.find((r) => r.proc_name === "policy_refresh_continuous_aggregate");
    expect(refreshJob, JSON.stringify(rows)).toMatchObject({ schedule_interval: "00:15:00", start_offset: "8 days", end_offset: "01:00:00" });
    const retentionJob = rows.find((r) => r.proc_name === "policy_retention");
    expect(retentionJob?.drop_after, JSON.stringify(rows)).toBe("90 days");
    const { rows: intervals } = await admin.query<{ covers: boolean }>("SELECT interval '8 days' > interval '7 days' AS covers");
    expect(intervals[0]?.covers).toBe(true);
  });

  it("fleet_ro y fleet_app solo leen: pueden hacer SELECT y no escribir", async () => {
    await expect(readOnly.query("SELECT count(*) FROM telemetry_hourly")).resolves.toBeDefined();
    await expect(app.query("SELECT count(*) FROM telemetry_hourly")).resolves.toBeDefined();

    const { rows } = await admin.query<{ role: string; write: boolean }>(
      `SELECT r AS role, has_table_privilege(r, 'telemetry_hourly', 'INSERT') OR has_table_privilege(r, 'telemetry_hourly', 'UPDATE')
              OR has_table_privilege(r, 'telemetry_hourly', 'DELETE') AS write
       FROM unnest(ARRAY['fleet_app', 'fleet_ro']) AS r`,
    );
    expect(rows).toEqual([
      { role: "fleet_app", write: false },
      { role: "fleet_ro", write: false },
    ]);
  });
});
