import { describe, expect, it } from "vitest";
import {
  deriveTrackingState,
  estimateClockSkewMs,
  nextPermissionStep,
  type PermissionsSnapshot,
  type TrackingInputs,
} from "./tracking-state";

const granted: PermissionsSnapshot = { foreground: "granted", background: "granted" };
const base: TrackingInputs = { shiftActive: true, permissions: granted, gpsEnabled: true };

describe("deriveTrackingState", () => {
  it("activo con turno, permisos y fix reciente", () => expect(deriveTrackingState(base)).toBe("active"));
  it("pausado sin turno", () => expect(deriveTrackingState({ ...base, shiftActive: false })).toBe("paused"));
  it("sin permiso manda sobre el turno", () => {
    for (const permissions of [
      { foreground: "denied", background: "granted" },
      { foreground: "granted", background: "denied" },
      { foreground: "undetermined", background: "undetermined" },
    ] as const) {
      expect(deriveTrackingState({ ...base, permissions })).toBe("no_permission");
      expect(deriveTrackingState({ ...base, permissions, shiftActive: false })).toBe("no_permission");
    }
  });
  it("sin señal cuando el GPS del teléfono está apagado con turno activo", () => {
    expect(deriveTrackingState({ ...base, gpsEnabled: false })).toBe("no_signal");
  });
  it("GPS apagado sin turno: pausado, no sin señal", () => {
    expect(deriveTrackingState({ ...base, gpsEnabled: false, shiftActive: false })).toBe("paused");
  });
});

describe("nextPermissionStep (primer plano y luego segundo plano)", () => {
  it("nada concedido: primero primer plano", () =>
    expect(nextPermissionStep({ foreground: "undetermined", background: "undetermined" })).toBe("request_foreground"));
  it("primer plano concedido: explicación y luego segundo plano", () =>
    expect(nextPermissionStep({ foreground: "granted", background: "undetermined" })).toBe("explain_then_request_background"));
  it("segundo plano denegado pero no bloqueado: se vuelve a explicar", () =>
    expect(nextPermissionStep({ foreground: "granted", background: "denied" })).toBe("explain_then_request_background"));
  it("bloqueado: guía a los ajustes", () => {
    expect(nextPermissionStep({ foreground: "blocked", background: "undetermined" })).toBe("open_settings");
    expect(nextPermissionStep({ foreground: "granted", background: "blocked" })).toBe("open_settings");
  });
  it("todo concedido", () => expect(nextPermissionStep(granted)).toBe("done"));
});

describe("estimateClockSkewMs", () => {
  it("compensa la mitad del viaje de ida y vuelta", () => {
    const server = "2026-10-05T12:00:00.000Z";
    const t = Date.parse(server);
    // teléfono 5 s adelantado, RTT de 400 ms
    expect(estimateClockSkewMs({ serverTime: server, sentAtMs: t + 5_000 - 200, receivedAtMs: t + 5_000 + 200 })).toBe(5_000);
  });
  it("negativo si el teléfono va atrasado; null si la hora es ilegible", () => {
    const t = Date.parse("2026-10-05T12:00:00.000Z");
    expect(estimateClockSkewMs({ serverTime: "2026-10-05T12:00:00.000Z", sentAtMs: t - 3_000, receivedAtMs: t - 3_000 })).toBe(-3_000);
    expect(estimateClockSkewMs({ serverTime: "x", sentAtMs: 0, receivedAtMs: 0 })).toBeNull();
  });
});
