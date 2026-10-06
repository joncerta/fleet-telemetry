import type {
  AlertTolerant,
  FleetSummary,
  SseSnapshotTolerant,
  StoppedVehiclesResponseTolerant,
  ZoneFeatureCollectionTolerant,
} from "@fleet/contracts";
import { createStore, type StoreApi } from "zustand/vanilla";
import { failed, idle, loading, ready, type Loadable } from "../../lib/loadable";
import { clockOffsetMs } from "../../lib/time/server-clock";
import type { ConnectionStatus } from "../stream/fleet-stream-client";
import { applyEvents, EMPTY_FLEET, mergeAlerts, replaceWithSnapshot, type FleetData, type FleetStreamEvent } from "./fleet-state";

export interface FleetResources {
  summary: Loadable<FleetSummary>;
  stopped: Loadable<StoppedVehiclesResponseTolerant>;
  zones: Loadable<ZoneFeatureCollectionTolerant>;
}
export type ResourceKey = keyof FleetResources;

export interface FleetStoreState extends FleetData, FleetResources {
  connection: ConnectionStatus;
  /** Desfase estimado `horaServidor - relojLocal` (ms). Base de "sin señal" y "minutos detenido". */
  serverOffsetMs: number;
  /** Vehículo seleccionado en la lista o en el mapa (se resaltan ambos). */
  selectedVehicleId: string | null;
}

export interface FleetStoreActions {
  applySnapshot(snapshot: SseSnapshotTolerant, clientNowMs: number): void;
  applyEvents(events: readonly FleetStreamEvent[]): void;
  mergeAlerts(alerts: readonly AlertTolerant[]): void;
  syncServerTime(serverTimeIso: string, clientNowMs: number): void;
  setConnection(status: ConnectionStatus): void;
  selectVehicle(vehicleId: string | null): void;
  startLoading(key: ResourceKey): void;
  resolveResource<K extends ResourceKey>(key: K, data: NonNullable<FleetResources[K]["data"]>, nowMs: number): void;
  failResource(key: ResourceKey, error: string): void;
  /** Vuelve al estado inicial (al cerrar sesión): un usuario nunca ve datos del tenant del anterior. */
  reset(): void;
}

export type FleetStore = FleetStoreState & FleetStoreActions;

const initialState = (): FleetStoreState => ({
  ...EMPTY_FLEET,
  connection: "connecting",
  serverOffsetMs: 0,
  selectedVehicleId: null,
  summary: idle(),
  stopped: idle(),
  zones: idle(),
});

/**
 * Store ÚNICO de la flota. Las transiciones son los reducers puros de `fleet-state.ts`; aquí solo se conectan. Los eventos llegan por
 * lote (`applyEvents`), nunca un `set` por evento. Es un store "vanilla" para que el mapa y el sincronizador lo usen sin React; los
 * componentes lo leen con selectores finos.
 */
export function createFleetStore(): StoreApi<FleetStore> {
  return createStore<FleetStore>()((set, get) => {
    const data = (): FleetData => {
      const { vehicles, alerts, cursor, ready: isReady } = get();
      return { vehicles, alerts, cursor, ready: isReady };
    };
    // Los reducers devuelven los mismos mapas si nada cambió: entonces no se notifica a nadie.
    const commit = (next: FleetData) => {
      const current = get();
      if (next.vehicles === current.vehicles && next.alerts === current.alerts && next.cursor === current.cursor && next.ready === current.ready) return;
      set({ vehicles: next.vehicles, alerts: next.alerts, cursor: next.cursor, ready: next.ready });
    };

    return {
      ...initialState(),

      applySnapshot(snapshot, clientNowMs) {
        const offset = clockOffsetMs(snapshot.serverTime, clientNowMs);
        const next = replaceWithSnapshot(snapshot);
        set({ vehicles: next.vehicles, alerts: next.alerts, cursor: next.cursor, ready: true, ...(offset !== null && { serverOffsetMs: offset }) });
      },

      applyEvents(events) {
        commit(applyEvents(data(), events));
      },

      mergeAlerts(alerts) {
        commit(mergeAlerts(data(), alerts));
      },

      syncServerTime(serverTimeIso, clientNowMs) {
        const offset = clockOffsetMs(serverTimeIso, clientNowMs);
        if (offset !== null) set({ serverOffsetMs: offset });
      },

      setConnection(status) {
        if (get().connection !== status) set({ connection: status });
      },

      selectVehicle(vehicleId) {
        if (get().selectedVehicleId !== vehicleId) set({ selectedVehicleId: vehicleId });
      },

      // `key` es una unión: el valor se arma como `Loadable<unknown>` y la firma pública de las acciones conserva el tipo de cada recurso.
      startLoading(key) {
        set({ [key]: loading<unknown>(get()[key]) } as Partial<FleetStoreState>);
      },

      resolveResource(key, value, nowMs) {
        set({ [key]: ready<unknown>(value, nowMs) } as Partial<FleetStoreState>);
      },

      failResource(key, error) {
        set({ [key]: failed<unknown>(get()[key], error) } as Partial<FleetStoreState>);
      },

      reset() {
        set(initialState());
      },
    };
  });
}
