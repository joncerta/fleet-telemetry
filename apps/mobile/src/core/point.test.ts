import { telemetryPointSchema } from "@fleet/contracts";
import { describe, expect, it } from "vitest";
import { buildPoint, type RawFix } from "./point";
import { VEHICLE_ID, uuid } from "./test-helpers";

const fix = (over: Partial<RawFix> = {}): RawFix => ({
  timestamp: 1_700_000_000_000,
  latitude: 4.6,
  longitude: -74.08,
  altitude: 2600,
  accuracy: 8,
  speed: 12.5,
  heading: 270,
  mocked: false,
  ...over,
});
const ctx = { vehicleId: VEHICLE_ID, newEventId: () => uuid(1) };

describe("buildPoint", () => {
  it("usa la hora del fix GPS y no la del reloj del teléfono", () => {
    const result = buildPoint(fix({ timestamp: Date.parse("2026-01-02T03:04:05.000Z") }), ctx);
    expect(result.ok && result.point.recordedAt).toBe("2026-01-02T03:04:05.000Z");
  });

  it("genera el eventId al capturar y el punto cumple telemetryPointSchema", () => {
    const result = buildPoint(fix(), ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.point.eventId).toBe(uuid(1));
      expect(telemetryPointSchema.safeParse(result.point).success).toBe(true);
      expect(result.point).toMatchObject({ lon: -74.08, lat: 4.6, speedMps: 12.5, headingDeg: 270, accuracyM: 8 });
    }
  });

  it("precisión peor que 50 m: se guarda marcado lowAccuracy, no se descarta", () => {
    const bad = buildPoint(fix({ accuracy: 51 }), ctx);
    const edge = buildPoint(fix({ accuracy: 50 }), ctx);
    expect(bad.ok && bad.point.lowAccuracy).toBe(true);
    expect(edge.ok && edge.point.lowAccuracy).toBe(false);
  });

  it("precisión desconocida o inválida: lowAccuracy y accuracyM null", () => {
    for (const accuracy of [null, 0, -1, Number.NaN]) {
      const r = buildPoint(fix({ accuracy }), ctx);
      expect(r.ok && r.point).toMatchObject({ accuracyM: null, lowAccuracy: true });
    }
  });

  it("ubicación simulada: se envía marcada, nunca se descarta", () => {
    const r = buildPoint(fix({ mocked: true }), ctx);
    expect(r.ok && r.point.mocked).toBe(true);
    const unknown = buildPoint(fix({ mocked: undefined }), ctx);
    expect(unknown.ok && unknown.point.mocked).toBe(false);
  });

  it("velocidad y rumbo que Android no tiene (-1) pasan a null; 360 se normaliza a 0", () => {
    const r = buildPoint(fix({ speed: -1, heading: -1 }), ctx);
    expect(r.ok && r.point).toMatchObject({ speedMps: null, headingDeg: null });
    const wrap = buildPoint(fix({ heading: 360 }), ctx);
    expect(wrap.ok && wrap.point.headingDeg).toBe(0);
    const absurd = buildPoint(fix({ speed: 400 }), ctx);
    expect(absurd.ok && absurd.point.speedMps).toBeNull();
  });

  it("un fix que no cumple el contrato no se encola y el motivo no lleva coordenadas", () => {
    for (const bad of [fix({ latitude: 95 }), fix({ longitude: Number.NaN }), fix({ timestamp: Number.NaN })]) {
      const r = buildPoint(bad, ctx);
      expect(r).toEqual({ ok: false, reason: "invalid_point" });
    }
    expect(buildPoint(fix(), { ...ctx, vehicleId: "no-uuid" }).ok).toBe(false);
  });
});
