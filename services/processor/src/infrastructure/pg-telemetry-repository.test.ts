import type { TelemetryRawEvent } from "@fleet/contracts";
import { describe, expect, it } from "vitest";
import { createPgTelemetryRepository, type TelemetryQueryable } from "./pg-telemetry-repository.js";

const event = (n: number, pointOverrides: Partial<TelemetryRawEvent["point"]> = {}): TelemetryRawEvent => ({
  schemaVersion: 1,
  tenantId: "9d7e1b34-2a6c-4f08-b5d3-6e4a8c1f0b92",
  deviceId: "5b8a3f6c-1e9d-4a27-8c40-7f2e6d1b9a35",
  receivedAt: "2026-03-14T20:00:00.000Z",
  point: {
    eventId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    vehicleId: "a1c4e9d2-7b3f-4c58-8e16-0d9f2b6a4c71",
    recordedAt: "2026-03-14T14:59:30.000-05:00",
    lon: -75.5636,
    lat: 6.2518,
    speedMps: 12.5,
    headingDeg: null,
    accuracyM: 8,
    mocked: false,
    lowAccuracy: true,
    ...pointOverrides,
  },
});

function fakePool(rowCount: number | null = 0) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const pool: TelemetryQueryable = {
    query: (sql, params) => {
      queries.push({ sql, params });
      return Promise.resolve({ rowCount });
    },
  };
  return { pool, queries };
}

describe("createPgTelemetryRepository (sin base real)", () => {
  it("un solo INSERT parametrizado con unnest, ON CONFLICT (event_id, recorded_at) DO NOTHING y ST_MakePoint(lon, lat) con SRID 4326", async () => {
    const { pool, queries } = fakePool(2);

    await createPgTelemetryRepository(pool).insertBatch([event(1), event(2)]);

    expect(queries).toHaveLength(1);
    const sql = queries[0]?.sql ?? "";
    expect(sql).toMatch(/INSERT INTO telemetry/);
    expect(sql).toMatch(/unnest\(/);
    expect(sql).toMatch(/ON CONFLICT \(event_id, recorded_at\) DO NOTHING/);
    expect(sql).toMatch(/ST_SetSRID\(ST_MakePoint\(t\.lon, t\.lat\), 4326\)/);
    // Ningún valor del evento entra en el texto del SQL.
    expect(sql).not.toMatch(/-75\.5636|6\.2518|00000000-0000/);
  });

  it("cada parámetro es un arreglo con una posición por evento, en el orden de las columnas del unnest", async () => {
    const { pool, queries } = fakePool(2);

    await createPgTelemetryRepository(pool).insertBatch([event(1, { altitudeM: 1500 }), event(2, { lon: -74.0721, lat: 4.711, speedMps: null })]);

    const params = queries[0]?.params ?? [];
    expect(params).toHaveLength(14);
    expect(params).toEqual([
      ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"],
      ["9d7e1b34-2a6c-4f08-b5d3-6e4a8c1f0b92", "9d7e1b34-2a6c-4f08-b5d3-6e4a8c1f0b92"],
      ["a1c4e9d2-7b3f-4c58-8e16-0d9f2b6a4c71", "a1c4e9d2-7b3f-4c58-8e16-0d9f2b6a4c71"],
      ["5b8a3f6c-1e9d-4a27-8c40-7f2e6d1b9a35", "5b8a3f6c-1e9d-4a27-8c40-7f2e6d1b9a35"],
      ["2026-03-14T14:59:30.000-05:00", "2026-03-14T14:59:30.000-05:00"],
      ["2026-03-14T20:00:00.000Z", "2026-03-14T20:00:00.000Z"],
      [-75.5636, -74.0721],
      [6.2518, 4.711],
      [12.5, null],
      [null, null],
      [8, 8],
      [1500, null],
      [false, false],
      [true, true],
    ]);
  });

  it("devuelve cuántas filas se insertaron (el resto eran duplicados)", async () => {
    const { pool } = fakePool(1);

    await expect(createPgTelemetryRepository(pool).insertBatch([event(1), event(2)])).resolves.toEqual({ inserted: 1 });
  });

  it("un rowCount nulo cuenta como cero", async () => {
    const { pool } = fakePool(null);

    await expect(createPgTelemetryRepository(pool).insertBatch([event(1)])).resolves.toEqual({ inserted: 0 });
  });

  it("sin eventos no consulta la base", async () => {
    const { pool, queries } = fakePool();

    await expect(createPgTelemetryRepository(pool).insertBatch([])).resolves.toEqual({ inserted: 0 });
    expect(queries).toEqual([]);
  });

  it("propaga el error de la base tal cual (el caso de uso lo clasifica)", async () => {
    const failure = Object.assign(new Error("terminating connection"), { code: "57P01" });
    const pool: TelemetryQueryable = { query: () => Promise.reject(failure) };

    await expect(createPgTelemetryRepository(pool).insertBatch([event(1)])).rejects.toBe(failure);
  });
});
