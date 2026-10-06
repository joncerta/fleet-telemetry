import { NO_SIGNAL_THRESHOLD_MS, type ZoneFeatureCollectionTolerant } from "@fleet/contracts";
import { describe, expect, it } from "vitest";
import { NOW_ISO, NOW_MS, vehicleState, ZONE_CRITICAL, ZONE_DEPOT } from "../../test-support/fixtures";
import { criticalZoneIdsOf, speedKmh, vehicleStatusOf } from "./vehicle-status";

const critical = new Set([ZONE_CRITICAL]);
const ago = (ms: number) => new Date(NOW_MS - ms).toISOString();

describe("vehicleStatusOf", () => {
  it("en movimiento y detenido según movement", () => {
    expect(vehicleStatusOf(vehicleState({ movement: "moving" }), NOW_ISO, critical)).toBe("moving");
    expect(vehicleStatusOf(vehicleState({ movement: "stopped", stoppedSince: ago(60_000), zoneIds: [ZONE_DEPOT] }), NOW_ISO, critical)).toBe("stopped");
  });

  it("detenido dentro de una zona crítica", () => {
    const vehicle = vehicleState({ movement: "stopped", stoppedSince: ago(60_000), zoneIds: [ZONE_DEPOT, ZONE_CRITICAL] });
    expect(vehicleStatusOf(vehicle, NOW_ISO, critical)).toBe("stopped_critical");
  });

  it("sin señal contra la hora del SERVIDOR, y gana a cualquier movement", () => {
    const stale = vehicleState({ movement: "moving", receivedAt: ago(NO_SIGNAL_THRESHOLD_MS + 1_000) });
    expect(vehicleStatusOf(stale, NOW_ISO, critical)).toBe("no_signal");
    // Justo en el umbral todavía tiene señal.
    expect(vehicleStatusOf(vehicleState({ receivedAt: ago(NO_SIGNAL_THRESHOLD_MS) }), NOW_ISO, critical)).toBe("moving");
  });

  it("con el reloj del navegador atrasado, la hora del servidor decide (no el reloj local)", () => {
    // El navegador cree que son las 14:50; el servidor dice 15:00. Un dato de las 14:52 tiene 8 min: sin señal.
    const vehicle = vehicleState({ receivedAt: "2026-10-06T14:52:00.000Z" });
    expect(vehicleStatusOf(vehicle, NOW_ISO, critical)).toBe("no_signal");
  });

  it("un movement desconocido (lectura tolerante) es 'unknown', nunca se adivina", () => {
    expect(vehicleStatusOf(vehicleState({ movement: "unknown" }), NOW_ISO, critical)).toBe("unknown");
  });
});

describe("criticalZoneIdsOf", () => {
  it("toma solo las zonas critical", () => {
    const ring: [number, number][] = [
      [-74.1, 4.6],
      [-74.0, 4.6],
      [-74.0, 4.7],
      [-74.1, 4.6],
    ];
    const zones: ZoneFeatureCollectionTolerant = {
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: { zoneId: ZONE_CRITICAL, name: "C", kind: "critical" } },
        { type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: { zoneId: ZONE_DEPOT, name: "D", kind: "depot" } },
      ],
    };
    expect([...criticalZoneIdsOf(zones)]).toEqual([ZONE_CRITICAL]);
    expect(criticalZoneIdsOf(null).size).toBe(0);
  });
});

describe("speedKmh", () => {
  it("convierte m/s a km/h y respeta el null del GPS", () => {
    expect(speedKmh(12.5)).toBe(45);
    expect(speedKmh(null)).toBeNull();
  });
});
