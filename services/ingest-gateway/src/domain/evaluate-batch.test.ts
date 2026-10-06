import { describe, expect, it } from "vitest";
import { evaluateBatch } from "./evaluate-batch.js";
import type { PointRules } from "./evaluate-point.js";

const VEHICLE = "a1c4e9d2-7b3f-4c58-8e16-0d9f2b6a4c71";
const OTHER_VEHICLE = "9d7e1b34-2a6c-4f08-b5d3-6e4a8c1f0b92";
const rules: PointRules = { vehicleId: VEHICLE, now: new Date("2026-03-14T20:00:00.000Z"), futureToleranceMs: 300_000, maxAgeMs: 7 * 86_400_000, maxPointBytes: 8_192 };

const E1 = "3f2b8c1e-5d4a-4e7b-9a61-2c8d0e5f7a10";
const E2 = "7c1d5e92-4b0a-4d63-9f28-3a6b8e0c4d17";
const E3 = "0e6c2a48-91d5-4f3b-8a07-b5d29c4e1f68";

const point = (eventId: string, overrides: Record<string, unknown> = {}) => ({
  eventId,
  vehicleId: VEHICLE,
  recordedAt: "2026-03-14T19:59:30.000Z",
  lon: -75.5636,
  lat: 6.2518,
  speedMps: null,
  headingDeg: null,
  accuracyM: null,
  mocked: false,
  lowAccuracy: false,
  ...overrides,
});

describe("evaluateBatch", () => {
  it("separa válidos y rechazados conservando el índice de cada rechazo", () => {
    const result = evaluateBatch(
      [point(E1), { eventId: E2, lat: 999 }, point(E3, { vehicleId: OTHER_VEHICLE }), point(E2, { recordedAt: "2030-01-01T00:00:00Z" })],
      rules,
    );

    expect(result.valid.map((p) => p.eventId)).toEqual([E1]);
    expect(result.rejected.map((r) => [r.index, r.reason, r.eventId])).toEqual([
      [1, "invalid_schema", E2],
      [2, "vehicle_mismatch", E3],
      [3, "future_timestamp", E2],
    ]);
  });

  it("un eventId repetido entre los válidos se conserva una vez, el primero, y no es un rechazo", () => {
    const result = evaluateBatch([point(E1, { lat: 6.1 }), point(E2), point(E1, { lat: 6.9 })], rules);

    expect(result.valid.map((p) => p.eventId)).toEqual([E1, E2]);
    expect(result.valid[0]?.lat).toBe(6.1);
    expect(result.rejected).toEqual([]);
  });

  it("los duplicados se detectan sin distinguir mayúsculas del uuid", () => {
    const result = evaluateBatch([point(E1), point(E1.toUpperCase())], rules);

    expect(result.valid).toHaveLength(1);
  });

  it("dos puntos inválidos con el mismo eventId se rechazan los dos, cada uno por su índice", () => {
    const result = evaluateBatch([{ eventId: E1, lat: 999 }, { eventId: E1, lat: 998 }], rules);

    expect(result.valid).toEqual([]);
    expect(result.rejected.map((r) => r.index)).toEqual([0, 1]);
  });

  it("un punto rechazado no impide aceptar después uno válido con el mismo eventId", () => {
    const result = evaluateBatch([point(E1, { recordedAt: "2030-01-01T00:00:00Z" }), point(E1)], rules);

    expect(result.valid.map((p) => p.eventId)).toEqual([E1]);
    expect(result.rejected.map((r) => r.index)).toEqual([0]);
  });

  it("un lote vacío no produce nada", () => {
    expect(evaluateBatch([], rules)).toEqual({ valid: [], rejected: [] });
  });
});
