import type { AlertsResponseTolerant, FleetSummary, StoppedVehiclesResponseTolerant, ZoneFeatureCollectionTolerant } from "@fleet/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NetworkError, UnauthorizedError } from "../../lib/api/http-client";
import { alert, NOW_MS, snapshot, stoppedResponse, summary, VEHICLE_A, VEHICLE_B, vehicleState } from "../../test-support/fixtures";
import type { FleetStreamCallbacks } from "../stream/fleet-stream-client";
import { ALERTS_QUERY, createFleetSync, STOPPED_QUERY } from "./fleet-sync";
import { createFleetStore } from "./fleet-store";

const zones: ZoneFeatureCollectionTolerant = { type: "FeatureCollection", features: [] };

/** Promesa controlable desde el test, para decidir el orden en que "responde" la API. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup() {
  const store = createFleetStore();
  let callbacks: FleetStreamCallbacks | null = null;
  const stream = { start: vi.fn(), stop: vi.fn(), reconnectNow: vi.fn() };
  const api = {
    getAlerts: vi.fn<(params: typeof ALERTS_QUERY) => Promise<AlertsResponseTolerant>>(() => Promise.resolve({ items: [], nextCursor: null })),
    getSummary: vi.fn<() => Promise<FleetSummary>>(() => Promise.resolve(summary())),
    getStoppedVehicles: vi.fn<(params: typeof STOPPED_QUERY) => Promise<StoppedVehiclesResponseTolerant>>(() => Promise.resolve(stoppedResponse())),
    getZones: vi.fn<() => Promise<ZoneFeatureCollectionTolerant>>(() => Promise.resolve(zones)),
  };
  const onUnauthorized = vi.fn();
  const verifyIdentity = vi.fn();
  const sync = createFleetSync({
    api,
    store,
    onUnauthorized,
    verifyIdentity,
    now: () => NOW_MS,
    flushMs: 200,
    summaryDebounceMs: 2_000,
    openStream: (received) => {
      callbacks = received;
      return stream;
    },
  });
  const stream$ = () => {
    if (callbacks === null) throw new Error("el stream no se abrió");
    return callbacks;
  };
  return { store, stream, api, onUnauthorized, verifyIdentity, sync, stream$ };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("createFleetSync", () => {
  it("abre el stream una vez y pide zonas, KPIs y detenidos al arrancar (no dependen del snapshot)", async () => {
    const { sync, stream, api, store } = setup();
    sync.start();
    sync.start();
    expect(stream.start).toHaveBeenCalledTimes(1);
    expect(api.getZones).toHaveBeenCalledTimes(1);
    expect(api.getSummary).toHaveBeenCalledTimes(1);
    expect(api.getStoppedVehicles).toHaveBeenCalledTimes(1);
    // Las alertas sí esperan al snapshot: lo pedido antes se perdería con el reemplazo.
    expect(api.getAlerts).not.toHaveBeenCalled();

    // Con el stream caído, los KPIs se siguen recargando (y se ven con su hora si fallan).
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.getSummary).toHaveBeenCalledTimes(2);
    expect(store.getState().summary.status).toBe("ready");
  });

  it("cada snapshot verifica la identidad de la sesión y recarga SIEMPRE las zonas (pueden ser de otra sesión tras reconectar)", async () => {
    const { sync, stream$, api, verifyIdentity } = setup();
    sync.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.getZones).toHaveBeenCalledTimes(1);
    expect(verifyIdentity).not.toHaveBeenCalled();

    stream$().onSnapshot(snapshot());
    await vi.advanceTimersByTimeAsync(0);
    expect(verifyIdentity).toHaveBeenCalledTimes(1);
    expect(api.getZones).toHaveBeenCalledTimes(2);

    stream$().onSnapshot(snapshot({ cursor: "180" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(verifyIdentity).toHaveBeenCalledTimes(2);
    expect(api.getZones).toHaveBeenCalledTimes(3);
  });

  it("cada snapshot reemplaza el estado y DESPUÉS vuelve a pedir /v1/alerts, /v1/summary y los detenidos", async () => {
    const { sync, stream$, api, store } = setup();
    sync.start();
    await vi.advanceTimersByTimeAsync(0);
    api.getSummary.mockClear();
    api.getStoppedVehicles.mockClear();

    stream$().onSnapshot(snapshot({ vehicles: [vehicleState()] }));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().vehicles[VEHICLE_A]).toBeDefined();
    expect(api.getAlerts).toHaveBeenCalledWith(ALERTS_QUERY, expect.any(AbortSignal));
    expect(api.getSummary).toHaveBeenCalledTimes(1);
    expect(api.getStoppedVehicles).toHaveBeenCalledWith(STOPPED_QUERY, expect.any(AbortSignal));
    expect(store.getState().summary.status).toBe("ready");

    // Reconexión: snapshot nuevo → reemplazo y nueva consulta (las alertas de la desconexión no vienen en el snapshot).
    const duringOutage = alert({ seq: "150", resolvedAt: "2026-10-06T15:02:00.000Z" });
    api.getAlerts.mockResolvedValueOnce({ items: [duringOutage], nextCursor: null });
    stream$().onSnapshot(snapshot({ cursor: "200", vehicles: [vehicleState({ vehicleId: VEHICLE_B, seq: "190" })] }));
    await vi.advanceTimersByTimeAsync(0);

    expect(Object.keys(store.getState().vehicles)).toEqual([VEHICLE_B]);
    expect(store.getState().alerts[duringOutage.alertId]).toBeDefined();
    expect(api.getAlerts).toHaveBeenCalledTimes(2);
    expect(api.getSummary).toHaveBeenCalledTimes(2);
  });

  it("acumula los eventos y los aplica en UN lote", async () => {
    const { sync, stream$, store } = setup();
    sync.start();
    stream$().onSnapshot(snapshot({ vehicles: [vehicleState({ seq: "10" })] }));
    await vi.advanceTimersByTimeAsync(0);

    const notifications = vi.fn();
    store.subscribe((state, previous) => {
      if (state.vehicles !== previous.vehicles) notifications();
    });
    for (let seq = 11; seq <= 20; seq += 1) stream$().onVehicleState(vehicleState({ seq: String(seq) }));
    expect(notifications).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);
    expect(notifications).toHaveBeenCalledTimes(1);
    expect(store.getState().vehicles[VEHICLE_A]?.seq).toBe("20");
  });

  it("al llegar un snapshot nuevo descarta los eventos pendientes de la conexión anterior", async () => {
    const { sync, stream$, store } = setup();
    sync.start();
    stream$().onSnapshot(snapshot({ vehicles: [vehicleState({ seq: "10" })] }));
    stream$().onVehicleState(vehicleState({ vehicleId: VEHICLE_B, seq: "11" }));

    stream$().onSnapshot(snapshot({ cursor: "300", vehicles: [vehicleState({ seq: "300" })] }));
    await vi.advanceTimersByTimeAsync(500);
    expect(store.getState().vehicles[VEHICLE_B]).toBeUndefined();
  });

  it("una respuesta vieja nunca pisa a una más nueva", async () => {
    const { sync, stream$, api, store } = setup();
    const first = deferred<FleetSummary>();
    const second = deferred<FleetSummary>();
    api.getSummary.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    // Primera petición: la del arranque; segunda: la del snapshot. Responde primero la segunda.
    sync.start();
    stream$().onSnapshot(snapshot());
    second.resolve(summary({ activeAlerts: 7 }));
    await vi.advanceTimersByTimeAsync(0);
    first.resolve(summary({ activeAlerts: 1 }));
    await vi.advanceTimersByTimeAsync(0);

    expect(store.getState().summary.data?.activeAlerts).toBe(7);
  });

  it("si una recarga falla, conserva el dato anterior y marca el error", async () => {
    const { sync, stream$, api, store } = setup();
    sync.start();
    stream$().onSnapshot(snapshot());
    await vi.advanceTimersByTimeAsync(0);

    api.getSummary.mockRejectedValueOnce(new NetworkError());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(store.getState().summary).toMatchObject({ status: "error", data: summary(), error: "No se pudo conectar con el servidor." });
  });

  it("un 401 de una lectura no se muestra como error (la API ya llevó al login)", async () => {
    const { sync, api, store } = setup();
    api.getSummary.mockRejectedValueOnce(new UnauthorizedError());
    sync.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().summary.status).toBe("loading");
    expect(store.getState().summary.error).toBeNull();
  });

  it("una alerta en vivo recarga los KPIs una sola vez por ráfaga", async () => {
    const { sync, stream$, api } = setup();
    sync.start();
    stream$().onSnapshot(snapshot());
    await vi.advanceTimersByTimeAsync(0);
    api.getSummary.mockClear();

    stream$().onAlert(alert());
    stream$().onAlert(alert());
    stream$().onAlert(alert());
    await vi.advanceTimersByTimeAsync(2_000);
    expect(api.getSummary).toHaveBeenCalledTimes(1);
  });

  it("refleja el estado de la conexión y propaga el 401 del stream", () => {
    const { sync, stream$, store, onUnauthorized } = setup();
    sync.start();
    stream$().onStatus("reconnecting");
    expect(store.getState().connection).toBe("reconnecting");
    stream$().onUnauthorized();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("tras stop, ninguna respuesta en vuelo ni evento toca el store", async () => {
    const { sync, stream$, api, store, stream } = setup();
    const pending = deferred<FleetSummary>();
    api.getSummary.mockReturnValueOnce(pending.promise);
    sync.start();
    stream$().onSnapshot(snapshot({ vehicles: [vehicleState({ seq: "10" })] }));
    stream$().onVehicleState(vehicleState({ seq: "11" }));

    sync.stop();
    pending.resolve(summary({ activeAlerts: 9 }));
    stream$().onVehicleState(vehicleState({ seq: "12" }));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(stream.stop).toHaveBeenCalledTimes(1);
    expect(store.getState().summary.data).toBeNull();
    expect(store.getState().vehicles[VEHICLE_A]?.seq).toBe("10");
  });
});
