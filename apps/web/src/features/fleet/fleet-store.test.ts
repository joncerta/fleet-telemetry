import { describe, expect, it } from "vitest";
import { alert, NOW_MS, snapshot, summary, VEHICLE_A, vehicleState } from "../../test-support/fixtures";
import { createFleetStore } from "./fleet-store";

describe("createFleetStore", () => {
  it("el snapshot reemplaza el estado y fija el desfase con la hora del servidor", () => {
    const store = createFleetStore();
    store.getState().applySnapshot(snapshot({ serverTime: "2026-10-06T15:00:00.000Z", vehicles: [vehicleState()] }), NOW_MS - 60_000);
    expect(store.getState()).toMatchObject({ ready: true, cursor: "100", serverOffsetMs: 60_000 });
    expect(store.getState().vehicles[VEHICLE_A]).toBeDefined();
  });

  it("un lote sin cambios no notifica a los suscriptores", () => {
    const store = createFleetStore();
    store.getState().applySnapshot(snapshot({ vehicles: [vehicleState({ seq: "10" })] }), NOW_MS);
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });
    store.getState().applyEvents([{ type: "vehicle.state", state: vehicleState({ seq: "9" }) }]);
    store.getState().mergeAlerts([]);
    expect(notifications).toBe(0);
  });

  it("un recurso que falla al recargar conserva el dato anterior y su hora", () => {
    const store = createFleetStore();
    store.getState().resolveResource("summary", summary(), 1_000);
    store.getState().startLoading("summary");
    store.getState().failResource("summary", "sin red");
    expect(store.getState().summary).toEqual({ status: "error", data: summary(), updatedAt: 1_000, error: "sin red" });
  });

  it("reset borra los datos del tenant (cierre de sesión)", () => {
    const store = createFleetStore();
    store.getState().applySnapshot(snapshot({ vehicles: [vehicleState()], alerts: [alert()] }), NOW_MS);
    store.getState().selectVehicle(VEHICLE_A);
    store.getState().resolveResource("summary", summary(), 1_000);
    store.getState().reset();
    expect(store.getState()).toMatchObject({ ready: false, vehicles: {}, alerts: {}, selectedVehicleId: null, summary: { data: null } });
  });
});
