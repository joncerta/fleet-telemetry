import { randomUUID } from "node:crypto";
import type { TelemetryRawEvent } from "@fleet/contracts";
import { createLogger, createPool, databaseAdminConfig, defaultMigrationsDir, loadConfig, migrate } from "@fleet/platform";
import { createTempDatabase, type TempDatabase } from "@fleet/platform/testing";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { classifyFailure } from "../domain/failure-classification.js";
import { createPgTelemetryRepository } from "./pg-telemetry-repository.js";

// Contra TimescaleDB real, sobre una base temporal con las migraciones reales y con el rol de los servicios (fleet_app):
// el INSERT debe funcionar con sus permisos, con el índice único de la hypertable y con PostGIS.
const config = loadConfig(z.object(databaseAdminConfig.shape));
const logger = createLogger({ service: "processor-repository-it", level: "error" });
const rolePasswords = { fleet_app: config.FLEET_APP_PASSWORD, fleet_ro: config.FLEET_RO_PASSWORD };

let db: TempDatabase;
let pool: Pool;

beforeAll(async () => {
  db = await createTempDatabase(config.DATABASE_ADMIN_URL);
  await migrate({ adminUrl: db.adminUrl, migrationsDir: defaultMigrationsDir, rolePasswords, logger });
  pool = createPool({ connectionString: db.urlFor("fleet_app", rolePasswords.fleet_app), applicationName: "processor-repository-it", logger, max: 4 });
});

afterAll(async () => {
  await pool?.end();
  await db?.drop();
});

const HOUR_MS = 3_600_000;
/** Instantes recientes (la retención de 90 días no los toca) y redondeados al milisegundo. */
const BASE_MS = Math.floor(Date.now() / 1_000) * 1_000 - HOUR_MS;

interface Scope {
  tenantId: string;
  vehicleId: string;
  deviceId: string;
}
const newScope = (): Scope => ({ tenantId: randomUUID(), vehicleId: randomUUID(), deviceId: randomUUID() });

/** ISO 8601 de un instante, escrito con un offset distinto de UTC (la hora local de Colombia, UTC-5). */
const asColombiaLocal = (ms: number): string => `${new Date(ms - 5 * HOUR_MS).toISOString().slice(0, -1)}-05:00`;

function eventOf(scope: Scope, overrides: { point?: Partial<TelemetryRawEvent["point"]>; receivedAt?: string } = {}): TelemetryRawEvent {
  return {
    schemaVersion: 1,
    tenantId: scope.tenantId,
    deviceId: scope.deviceId,
    receivedAt: overrides.receivedAt ?? new Date(BASE_MS + 5_000).toISOString(),
    point: {
      eventId: randomUUID(),
      vehicleId: scope.vehicleId,
      recordedAt: new Date(BASE_MS).toISOString(),
      lon: -75.5636,
      lat: 6.2518,
      speedMps: 12.5,
      headingDeg: 90,
      accuracyM: 8,
      mocked: false,
      lowAccuracy: true,
      ...overrides.point,
    },
  };
}

interface Row {
  event_id: string;
  tenant_id: string;
  vehicle_id: string;
  device_id: string;
  recorded_at: Date;
  received_at: Date;
  lon: number;
  lat: number;
  srid: number;
  speed_mps: number | null;
  heading_deg: number | null;
  accuracy_m: number | null;
  altitude_m: number | null;
  mocked: boolean;
  low_accuracy: boolean;
}

/** Filas de un vehículo de un tenant (siempre con tenant y rango de tiempo: es una hypertable). */
async function rowsOf(scope: Scope): Promise<Row[]> {
  const { rows } = await pool.query<Row>(
    `SELECT event_id, tenant_id, vehicle_id, device_id, recorded_at, received_at,
            ST_X(geom) AS lon, ST_Y(geom) AS lat, ST_SRID(geom) AS srid,
            speed_mps, heading_deg, accuracy_m, altitude_m, mocked, low_accuracy
       FROM telemetry
      WHERE tenant_id = $1 AND vehicle_id = $2 AND recorded_at >= $3 AND recorded_at < $4
      ORDER BY recorded_at, event_id`,
    [scope.tenantId, scope.vehicleId, new Date(BASE_MS - 24 * HOUR_MS), new Date(BASE_MS + 24 * HOUR_MS)],
  );
  return rows;
}

describe("createPgTelemetryRepository contra la base real", () => {
  it("inserta un lote en una sola operación: la geometría es (lon, lat) con SRID 4326 y el resto de columnas llegan intactas", async () => {
    const scope = newScope();
    const repository = createPgTelemetryRepository(pool);
    const medellin = eventOf(scope, { point: { lon: -75.5636, lat: 6.2518, altitudeM: 1495.5 } });
    const bogota = eventOf(scope, {
      point: { lon: -74.0721, lat: 4.711, speedMps: null, headingDeg: null, accuracyM: null, mocked: true, lowAccuracy: false, recordedAt: new Date(BASE_MS + 1_000).toISOString() },
    });

    await expect(repository.insertBatch([medellin, bogota])).resolves.toEqual({ inserted: 2 });

    const rows = await rowsOf(scope);
    expect(rows).toHaveLength(2);
    const [first, second] = rows;
    // ST_X es la longitud y ST_Y la latitud (regla 13): un orden invertido pondría a Medellín en el océano.
    expect(first).toMatchObject({
      event_id: medellin.point.eventId,
      tenant_id: scope.tenantId,
      vehicle_id: scope.vehicleId,
      device_id: scope.deviceId,
      lon: -75.5636,
      lat: 6.2518,
      srid: 4326,
      speed_mps: 12.5,
      heading_deg: 90,
      accuracy_m: 8,
      altitude_m: 1495.5,
      mocked: false,
      low_accuracy: true,
    });
    expect(second).toMatchObject({
      event_id: bogota.point.eventId,
      lon: -74.0721,
      lat: 4.711,
      srid: 4326,
      speed_mps: null,
      heading_deg: null,
      accuracy_m: null,
      altitude_m: null,
      mocked: true,
      low_accuracy: false,
    });
  });

  it("es PostGIS de verdad: la distancia en metros entre dos filas insertadas es la esperada (Medellín-Bogotá, ~240 km)", async () => {
    const scope = newScope();
    await createPgTelemetryRepository(pool).insertBatch([
      eventOf(scope, { point: { lon: -75.5636, lat: 6.2518 } }),
      eventOf(scope, { point: { lon: -74.0721, lat: 4.711, recordedAt: new Date(BASE_MS + 1_000).toISOString() } }),
    ]);

    const { rows } = await pool.query<{ meters: number }>(
      `SELECT ST_Distance(a.geom::geography, b.geom::geography) AS meters
         FROM telemetry a, telemetry b
        WHERE a.tenant_id = $1 AND b.tenant_id = $1 AND a.vehicle_id = $2 AND b.vehicle_id = $2
          AND a.recorded_at >= $3 AND a.recorded_at < $4 AND b.recorded_at >= $3 AND b.recorded_at < $4
          AND a.recorded_at < b.recorded_at`,
      [scope.tenantId, scope.vehicleId, new Date(BASE_MS - HOUR_MS), new Date(BASE_MS + HOUR_MS)],
    );
    const meters = Number(rows[0]?.meters);
    expect(meters).toBeGreaterThan(230_000);
    expect(meters).toBeLessThan(250_000);
  });

  it("recorded_at y received_at se guardan en UTC aunque lleguen con otro offset", async () => {
    const scope = newScope();
    const event = eventOf(scope, {
      point: { recordedAt: asColombiaLocal(BASE_MS) },
      receivedAt: asColombiaLocal(BASE_MS + 5_000),
    });
    expect(event.point.recordedAt).toMatch(/-05:00$/);

    await createPgTelemetryRepository(pool).insertBatch([event]);

    const [row] = await rowsOf(scope);
    expect(row?.recorded_at.toISOString()).toBe(new Date(BASE_MS).toISOString());
    expect(row?.received_at.toISOString()).toBe(new Date(BASE_MS + 5_000).toISOString());
    // También por el lado de Postgres: el instante en UTC es el mismo, sin depender de la zona de la sesión.
    const { rows } = await pool.query<{ utc: string }>(
      "SELECT to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS') AS utc FROM telemetry WHERE tenant_id = $1 AND vehicle_id = $2 AND recorded_at >= $3 AND recorded_at < $4",
      [scope.tenantId, scope.vehicleId, new Date(BASE_MS - HOUR_MS), new Date(BASE_MS + HOUR_MS)],
    );
    expect(rows[0]?.utc).toBe(new Date(BASE_MS).toISOString().slice(0, 19));
  });

  it("reinsertar el mismo lote es un no-op: inserted 0 y las filas no cambian", async () => {
    const scope = newScope();
    const repository = createPgTelemetryRepository(pool);
    const batch = [eventOf(scope), eventOf(scope, { point: { recordedAt: new Date(BASE_MS + 1_000).toISOString() } })];
    await repository.insertBatch(batch);
    const before = await rowsOf(scope);

    await expect(repository.insertBatch(batch)).resolves.toEqual({ inserted: 0 });

    expect(await rowsOf(scope)).toEqual(before);
  });

  it("un duplicado no impide insertar el nuevo del mismo lote: inserted cuenta solo las filas nuevas", async () => {
    const scope = newScope();
    const repository = createPgTelemetryRepository(pool);
    const existing = eventOf(scope);
    await repository.insertBatch([existing]);

    const fresh = eventOf(scope, { point: { recordedAt: new Date(BASE_MS + 2_000).toISOString() } });
    await expect(repository.insertBatch([existing, fresh])).resolves.toEqual({ inserted: 1 });

    expect((await rowsOf(scope)).map((row) => row.event_id).sort()).toEqual([existing.point.eventId, fresh.point.eventId].sort());
  });

  it("el mismo punto repetido DENTRO del mismo INSERT deja una sola fila", async () => {
    const scope = newScope();
    const event = eventOf(scope);

    await expect(createPgTelemetryRepository(pool).insertBatch([event, event, event])).resolves.toEqual({ inserted: 1 });

    expect(await rowsOf(scope)).toHaveLength(1);
  });

  it("el mismo punto con el instante escrito en otra zona horaria (UTC-5 y Z) es el mismo punto", async () => {
    const scope = newScope();
    const repository = createPgTelemetryRepository(pool);
    const utc = eventOf(scope);
    const local = eventOf(scope, { point: { eventId: utc.point.eventId, recordedAt: asColombiaLocal(BASE_MS) } });

    await repository.insertBatch([utc]);

    await expect(repository.insertBatch([local])).resolves.toEqual({ inserted: 0 });
    expect(await rowsOf(scope)).toHaveLength(1);
  });

  it("el mismo eventId con OTRO recordedAt son dos filas (caso límite documentado de la migración 003)", async () => {
    const scope = newScope();
    const first = eventOf(scope);
    const buggyRetry = eventOf(scope, { point: { eventId: first.point.eventId, recordedAt: new Date(BASE_MS + 60_000).toISOString() } });

    await expect(createPgTelemetryRepository(pool).insertBatch([first, buggyRetry])).resolves.toEqual({ inserted: 2 });
  });

  it("el tenant, el dispositivo y el vehículo son los del evento: dos tenants no se mezclan", async () => {
    const [a, b] = [newScope(), newScope()];
    const repository = createPgTelemetryRepository(pool);

    await repository.insertBatch([eventOf(a), eventOf(b)]);

    expect((await rowsOf(a)).map((row) => row.tenant_id)).toEqual([a.tenantId]);
    expect((await rowsOf(b)).map((row) => row.tenant_id)).toEqual([b.tenantId]);
  });

  it("inserta 5000 filas (el máximo del tramo configurable) en una sola sentencia", async () => {
    const scope = newScope();
    const events = Array.from({ length: 5_000 }, (_, i) => eventOf(scope, { point: { recordedAt: new Date(BASE_MS + i * 1_000).toISOString() } }));

    await expect(createPgTelemetryRepository(pool).insertBatch(events)).resolves.toEqual({ inserted: 5_000 });

    const { rows } = await pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM telemetry WHERE tenant_id = $1 AND vehicle_id = $2 AND recorded_at >= $3 AND recorded_at < $4",
      [scope.tenantId, scope.vehicleId, new Date(BASE_MS - HOUR_MS), new Date(BASE_MS + 24 * HOUR_MS)],
    );
    expect(Number(rows[0]?.n)).toBe(5_000);
  });

  describe("fallos reales de la base", () => {
    it("un dato que Postgres rechaza (año 0000) falla con un SQLSTATE de datos, es permanente y NO deja nada del lote (atómico)", async () => {
      const scope = newScope();
      const good = eventOf(scope);
      const poison = eventOf(scope, { point: { recordedAt: "0000-01-01T00:00:00.000Z" } });

      const failure = await createPgTelemetryRepository(pool)
        .insertBatch([good, poison])
        .catch((error: unknown) => error);

      expect(failure).toMatchObject({ code: expect.stringMatching(/^22/) as string });
      expect(classifyFailure(failure)).toBe("permanent");
      expect(await rowsOf(scope)).toEqual([]);
    });

    it("un valor con forma de inyección SQL se trata como dato: falla por tipo (clase 22), no ejecuta nada, y la tabla sigue ahí", async () => {
      const scope = newScope();
      const injected = { ...eventOf(scope), tenantId: "'; DROP TABLE telemetry; --" };

      const failure = await createPgTelemetryRepository(pool)
        .insertBatch([injected])
        .catch((error: unknown) => error);

      expect(failure).toMatchObject({ code: "22P02" });
      expect(classifyFailure(failure)).toBe("permanent");
      await expect(pool.query("SELECT 1 FROM telemetry LIMIT 1")).resolves.toBeDefined();
    });

    it("con la base inalcanzable (conexión rechazada) el error es transitorio", async () => {
      const refused = createPool({
        connectionString: "postgres://fleet_app:x@127.0.0.1:1/fleet",
        applicationName: "processor-repository-it-refused",
        logger,
        max: 1,
        connectionTimeoutMs: 2_000,
      });
      try {
        const failure = await createPgTelemetryRepository(refused)
          .insertBatch([eventOf(newScope())])
          .catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(Error);
        expect(classifyFailure(failure)).toBe("transient");
      } finally {
        await refused.end();
      }
    });

    it("con la conexión terminada por el administrador (57P01) el error es transitorio", async () => {
      const applicationName = `processor-repository-it-victim-${randomUUID().slice(0, 8)}`;
      const victim = createPool({ connectionString: db.urlFor("fleet_app", rolePasswords.fleet_app), applicationName, logger, max: 1 });
      try {
        const sleeping = victim.query("SELECT pg_sleep(30)").catch((error: unknown) => error);
        // Espera por sondeo a que la consulta esté corriendo antes de terminarla.
        for (let i = 0; ; i += 1) {
          const { rows } = await pool.query<{ n: string }>("SELECT count(*) AS n FROM pg_stat_activity WHERE application_name = $1 AND state = 'active'", [applicationName]);
          if (Number(rows[0]?.n) > 0) break;
          if (i > 100) throw new Error("La consulta de prueba no llegó a ejecutarse.");
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const admin = createPool({ connectionString: db.adminUrl, applicationName: "processor-repository-it-admin", logger, max: 1 });
        try {
          await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1", [applicationName]);
        } finally {
          await admin.end();
        }

        const failure = await sleeping;

        expect(failure).toMatchObject({ code: "57P01" });
        expect(classifyFailure(failure)).toBe("transient");
      } finally {
        await victim.end();
      }
    });
  });
});

// La política de compresión (migración 003) comprime los chunks de más de 7 días, y el móvil puede reenviar puntos de días atrás
// (cola offline). El camino real es insertBatch con ON CONFLICT DO NOTHING sobre un chunk comprimido: un duplicado debe ser un
// no-op y un punto nuevo debe insertarse, también cuando el mismo lote toca a la vez un chunk comprimido y otro sin comprimir.
describe("idempotencia sobre chunks comprimidos (por insertBatch, el camino real)", () => {
  const DAY_MS = 24 * HOUR_MS;
  /** Instantes de un chunk viejo (3 días atrás, dentro de la retención) y de uno reciente: son chunks distintos de 1 día. */
  const OLD_MS = BASE_MS - 3 * DAY_MS;

  /** Filas del vehículo en un rango de tiempo (siempre con tenant y rango: es una hypertable). */
  async function countIn(scope: Scope, fromMs: number, toMs: number): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM telemetry WHERE tenant_id = $1 AND vehicle_id = $2 AND recorded_at >= $3 AND recorded_at < $4",
      [scope.tenantId, scope.vehicleId, new Date(fromMs), new Date(toMs)],
    );
    return Number(rows[0]?.n);
  }

  it("un lote que mezcla duplicados del chunk comprimido, puntos nuevos de ese chunk y puntos de un chunk sin comprimir inserta solo lo nuevo", async () => {
    const scope = newScope();
    const repository = createPgTelemetryRepository(pool);
    const at = (baseMs: number, offsetS: number) => ({ recordedAt: new Date(baseMs + offsetS * 1_000).toISOString() });

    const compressedExisting = [0, 1, 2, 3, 4].map((i) => eventOf(scope, { point: at(OLD_MS, i) }));
    const uncompressedExisting = [0, 1].map((i) => eventOf(scope, { point: at(BASE_MS, i) }));
    await expect(repository.insertBatch([...compressedExisting, ...uncompressedExisting])).resolves.toEqual({ inserted: 7 });

    // Se comprime SOLO el chunk viejo y se comprueba que de verdad quedó comprimido (y el reciente no).
    const admin = createPool({ connectionString: db.adminUrl, applicationName: "processor-repository-it-compress", logger, max: 1 });
    try {
      const { rows: compressed } = await admin.query<{ n: string }>(
        "SELECT count(*) AS n FROM (SELECT compress_chunk(c, if_not_compressed => true) FROM show_chunks('telemetry', older_than => $1::timestamptz, newer_than => $2::timestamptz) c) AS done",
        [new Date(OLD_MS + DAY_MS), new Date(OLD_MS - DAY_MS)],
      );
      expect(Number(compressed[0]?.n)).toBeGreaterThanOrEqual(1);
      const { rows: state } = await admin.query<{ compressed: number; uncompressed: number }>(
        `SELECT count(*) FILTER (WHERE is_compressed)::int AS compressed, count(*) FILTER (WHERE NOT is_compressed)::int AS uncompressed
           FROM timescaledb_information.chunks
          WHERE hypertable_name = 'telemetry' AND range_end > $1::timestamptz AND range_start < $2::timestamptz`,
        [new Date(OLD_MS - DAY_MS), new Date(BASE_MS + DAY_MS)],
      );
      expect(state[0]?.compressed).toBeGreaterThanOrEqual(1);
      expect(state[0]?.uncompressed).toBeGreaterThanOrEqual(1);
    } finally {
      await admin.end();
    }

    const compressedNew = [10, 11, 12, 13].map((i) => eventOf(scope, { point: at(OLD_MS, i) }));
    const uncompressedNew = [10, 11].map((i) => eventOf(scope, { point: at(BASE_MS, i) }));
    const batch = [
      ...compressedExisting.slice(0, 3), // duplicados en el chunk comprimido
      ...compressedNew, // nuevos en el chunk comprimido
      ...uncompressedExisting, // duplicados en el chunk sin comprimir
      ...uncompressedNew, // nuevos en el chunk sin comprimir
    ];

    await expect(repository.insertBatch(batch)).resolves.toEqual({ inserted: compressedNew.length + uncompressedNew.length });

    expect(await countIn(scope, OLD_MS - HOUR_MS, OLD_MS + HOUR_MS)).toBe(compressedExisting.length + compressedNew.length);
    expect(await countIn(scope, BASE_MS - HOUR_MS, BASE_MS + HOUR_MS)).toBe(uncompressedExisting.length + uncompressedNew.length);

    // Reenviar el mismo lote entero es un no-op en ambos chunks.
    await expect(repository.insertBatch(batch)).resolves.toEqual({ inserted: 0 });
    expect(await countIn(scope, OLD_MS - HOUR_MS, BASE_MS + HOUR_MS)).toBe(compressedExisting.length + compressedNew.length + uncompressedExisting.length + uncompressedNew.length);
  });
});
