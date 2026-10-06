import { describe, expect, it } from "vitest";
import { alert, snapshot, VEHICLE_A, VEHICLE_B, vehicleState } from "../../test-support/fixtures";
import { applyEvents, EMPTY_FLEET, MAX_RESOLVED_ALERTS, mergeAlerts, replaceWithSnapshot, type FleetStreamEvent } from "./fleet-state";

const vehicleEvent = (overrides: Parameters<typeof vehicleState>[0]): FleetStreamEvent => ({ type: "vehicle.state", state: vehicleState(overrides) });

describe("replaceWithSnapshot", () => {
  it("reemplaza el estado: lo que no viene en el snapshot desaparece", () => {
    const before = replaceWithSnapshot(snapshot({ vehicles: [vehicleState({ vehicleId: VEHICLE_A })], alerts: [alert()] }));
    const after = replaceWithSnapshot(snapshot({ cursor: "200", vehicles: [vehicleState({ vehicleId: VEHICLE_B, seq: "150" })], alerts: [] }));

    expect(Object.keys(before.vehicles)).toEqual([VEHICLE_A]);
    expect(Object.keys(after.vehicles)).toEqual([VEHICLE_B]);
    expect(after.alerts).toEqual({});
    expect(after).toMatchObject({ cursor: "200", ready: true });
  });

  it("si el snapshot repite un vehículo, se queda el de mayor seq", () => {
    const data = replaceWithSnapshot(snapshot({ vehicles: [vehicleState({ seq: "30", lon: -74.2 }), vehicleState({ seq: "12", lon: -74.0 })] }));
    expect(data.vehicles[VEHICLE_A]?.lon).toBe(-74.2);
  });
});

describe("applyEvents", () => {
  const base = replaceWithSnapshot(snapshot({ vehicles: [vehicleState({ seq: "10" })] }));

  it("aplica un evento más nuevo que el estado del vehículo", () => {
    const next = applyEvents(base, [vehicleEvent({ seq: "11", lon: -74.05 })]);
    expect(next.vehicles[VEHICLE_A]).toMatchObject({ seq: "11", lon: -74.05 });
  });

  it("ignora un evento con seq viejo o igual (duplicado) y devuelve la misma referencia", () => {
    expect(applyEvents(base, [vehicleEvent({ seq: "9", lon: 0 })])).toBe(base);
    expect(applyEvents(base, [vehicleEvent({ seq: "10", lon: 0 })])).toBe(base);
  });

  it("compara seq como enteros, no como strings ni como number (más allá de 2^53)", () => {
    const big = replaceWithSnapshot(snapshot({ vehicles: [vehicleState({ seq: "9007199254740992" })] }));
    expect(applyEvents(big, [vehicleEvent({ seq: "9007199254740993", lon: -74.3 })]).vehicles[VEHICLE_A]?.lon).toBe(-74.3);
    // Como strings, "9" > "10"; como enteros, no.
    expect(applyEvents(base, [vehicleEvent({ seq: "9" })])).toBe(base);
  });

  it("el orden es por vehículo: un seq alto de un vehículo no bloquea a otro", () => {
    const next = applyEvents(base, [vehicleEvent({ vehicleId: VEHICLE_A, seq: "500" }), vehicleEvent({ vehicleId: VEHICLE_B, seq: "11" })]);
    expect(next.vehicles[VEHICLE_A]?.seq).toBe("500");
    expect(next.vehicles[VEHICLE_B]?.seq).toBe("11");
  });

  it("dentro de un lote, un evento viejo que llega después del nuevo no retrocede el estado", () => {
    const next = applyEvents(base, [vehicleEvent({ seq: "13", lon: -74.13 }), vehicleEvent({ seq: "12", lon: -74.12 })]);
    expect(next.vehicles[VEHICLE_A]).toMatchObject({ seq: "13", lon: -74.13 });
  });

  it("ignora un tipo de evento desconocido sin romper", () => {
    const unknownEvent = { type: "zone.updated", zone: {} } as unknown as FleetStreamEvent;
    expect(applyEvents(base, [unknownEvent])).toBe(base);
    expect(applyEvents(base, [unknownEvent, vehicleEvent({ seq: "11" })]).vehicles[VEHICLE_A]?.seq).toBe("11");
  });

  it("antes del primer snapshot no aplica nada (el snapshot es la base)", () => {
    expect(applyEvents(EMPTY_FLEET, [vehicleEvent({ seq: "11" })])).toBe(EMPTY_FLEET);
  });

  it("una alerta se aplica por alertId solo con seq mayor: la resolución reemplaza al alta y una resolución vieja no", () => {
    const raised = alert({ seq: "20" });
    const withAlert = applyEvents(base, [{ type: "alert", alert: raised }]);
    const resolved = applyEvents(withAlert, [{ type: "alert", alert: { ...raised, seq: "25", resolvedAt: "2026-10-06T15:05:00.000Z" } }]);
    expect(resolved.alerts[raised.alertId]?.resolvedAt).toBe("2026-10-06T15:05:00.000Z");

    const replayed = applyEvents(resolved, [{ type: "alert", alert: raised }]);
    expect(replayed).toBe(resolved);
  });

  it("conserva todas las activas y recorta las resueltas más viejas por encima del máximo", () => {
    const active = alert({ seq: "1" });
    const resolvedAlerts = Array.from({ length: MAX_RESOLVED_ALERTS + 5 }, (_, index) =>
      alert({ seq: String(100 + index), resolvedAt: "2026-10-06T15:05:00.000Z" }),
    );
    const next = mergeAlerts(base, [active, ...resolvedAlerts]);
    const kept = Object.values(next.alerts);

    expect(kept).toHaveLength(MAX_RESOLVED_ALERTS + 1);
    expect(next.alerts[active.alertId]).toBeDefined();
    // Las 5 resueltas con menor seq son las recortadas.
    for (const old of resolvedAlerts.slice(0, 5)) expect(next.alerts[old.alertId]).toBeUndefined();
  });
});

describe("mergeAlerts", () => {
  it("agrega las alertas de /v1/alerts y respeta el seq por alertId", () => {
    const live = alert({ seq: "40", resolvedAt: "2026-10-06T15:05:00.000Z" });
    const data = replaceWithSnapshot(snapshot({ alerts: [live] }));
    const fromRest = [{ ...live, seq: "30", resolvedAt: null }, alert({ seq: "35" })];

    const next = mergeAlerts(data, fromRest);
    expect(next.alerts[live.alertId]?.resolvedAt).toBe("2026-10-06T15:05:00.000Z");
    expect(Object.keys(next.alerts)).toHaveLength(2);
  });
});
