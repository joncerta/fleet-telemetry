import type { StoreApi } from "zustand/vanilla";
import { NetworkError, UnauthorizedError } from "../../lib/api/http-client";
import type { FleetApi } from "../../lib/api/fleet-api";
import type { LogFn } from "../../lib/log";
import type { FleetStreamCallbacks, FleetStreamHandle } from "../stream/fleet-stream-client";
import type { FleetStreamEvent } from "./fleet-state";
import type { FleetStore, ResourceKey } from "./fleet-store";

/** "Vehículos detenidos más de 20 minutos en zonas críticas" (`/v1/vehicles/stopped`). */
export const STOPPED_QUERY = { minMinutes: 20, zoneKind: "critical", limit: 50 } as const;
/** Historial reciente de alertas (activas y resueltas): incluye las ocurridas durante una desconexión, que el snapshot no trae. */
export const ALERTS_QUERY = { status: "all", limit: 50 } as const;

export interface FleetSyncOptions {
  api: Pick<FleetApi, "getAlerts" | "getSummary" | "getStoppedVehicles" | "getZones">;
  store: StoreApi<FleetStore>;
  openStream: (callbacks: FleetStreamCallbacks) => FleetStreamHandle;
  onUnauthorized: () => void;
  now?: () => number;
  /** Los eventos se acumulan y se aplican juntos cada `flushMs`: un `set` por lote, no por evento. */
  flushMs?: number;
  /** Recarga de KPIs y detenidos (los minutos y "sin señal" avanzan aunque no lleguen eventos). */
  refreshMs?: number;
  /** Tras una alerta en vivo, los KPIs se recargan una vez pasado este tiempo (una ráfaga de alertas = una recarga). */
  summaryDebounceMs?: number;
  log?: LogFn;
}

export interface FleetSync {
  start(): void;
  stop(): void;
}

const messageOf = (error: unknown): string =>
  error instanceof NetworkError ? "No se pudo conectar con el servidor." : "No se pudieron cargar los datos.";

/**
 * Sincroniza el store de la flota con fleet-api: el stream SSE (estado en vivo) y las lecturas REST que lo completan.
 *
 * - Cada snapshot (el primero y el de cada reconexión) reemplaza el estado y DESPUÉS vuelve a pedir `/v1/alerts` y `/v1/summary` (y los
 *   detenidos): lo pedido antes del snapshot se perdería con el reemplazo. Los eventos pendientes de la conexión anterior se descartan:
 *   el snapshot nuevo ya los incluye.
 * - Los KPIs salen de `/v1/summary` (incluye los vehículos que nunca reportaron), no de contar el store. Se piden al arrancar, tras
 *   cada snapshot, tras una alerta en vivo y cada `refreshMs`.
 * - Una respuesta vieja nunca pisa a una más nueva: por recurso, solo se aplica la respuesta de la última petición.
 * - Tras `stop()`, ninguna respuesta en vuelo toca el store (se abortan).
 */
export function createFleetSync(options: FleetSyncOptions): FleetSync {
  const now = options.now ?? Date.now;
  const flushMs = options.flushMs ?? 200;
  const refreshMs = options.refreshMs ?? 30_000;
  const summaryDebounceMs = options.summaryDebounceMs ?? 2_000;
  const log = options.log ?? (() => undefined);
  const store = () => options.store.getState();

  let stream: FleetStreamHandle | null = null;
  let stopped = false;
  let pending: FleetStreamEvent[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let summaryTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  const controller = new AbortController();
  const latestRequest: Record<ResourceKey | "alerts", number> = { summary: 0, stopped: 0, zones: 0, alerts: 0 };

  const flush = () => {
    flushTimer = undefined;
    if (stopped || pending.length === 0) return;
    const batch = pending;
    pending = [];
    store().applyEvents(batch);
  };

  const enqueue = (event: FleetStreamEvent) => {
    pending.push(event);
    flushTimer ??= setTimeout(flush, flushMs);
  };

  /** Corre `load` y aplica su resultado solo si sigue siendo la última petición de `key` y la sincronización no se detuvo. */
  const latestOnly = async <T>(key: ResourceKey | "alerts", load: (signal: AbortSignal) => Promise<T>, apply: (value: T) => void, onError: (error: unknown) => void) => {
    const id = ++latestRequest[key];
    try {
      const value = await load(controller.signal);
      if (!stopped && id === latestRequest[key]) apply(value);
    } catch (error) {
      if (stopped || id !== latestRequest[key]) return;
      // El 401 ya lo atendió la API (lleva al login); no es un error que mostrar.
      if (error instanceof UnauthorizedError) return;
      onError(error);
    }
  };

  const loadResource = <K extends ResourceKey>(
    key: K,
    load: (signal: AbortSignal) => Promise<NonNullable<FleetStore[K]["data"]>>,
    serverTimeOf?: (value: NonNullable<FleetStore[K]["data"]>) => string,
  ) => {
    store().startLoading(key);
    return latestOnly(
      key,
      load,
      (value) => {
        if (serverTimeOf !== undefined) store().syncServerTime(serverTimeOf(value), now());
        store().resolveResource(key, value, now());
      },
      (error) => {
        log("No se pudo cargar un recurso", { resource: key });
        store().failResource(key, messageOf(error));
      },
    );
  };

  const loadSummary = () => loadResource("summary", (signal) => options.api.getSummary(signal), (summary) => summary.serverTime);
  const loadStopped = () =>
    loadResource("stopped", (signal) => options.api.getStoppedVehicles(STOPPED_QUERY, signal), (stoppedVehicles) => stoppedVehicles.serverTime);
  const loadZones = () => loadResource("zones", (signal) => options.api.getZones(signal));
  const loadAlerts = () =>
    latestOnly(
      "alerts",
      (signal) => options.api.getAlerts(ALERTS_QUERY, signal),
      (page) => store().mergeAlerts(page.items),
      () => log("No se pudo cargar el historial de alertas"),
    );

  const resync = () => {
    void loadAlerts();
    void loadSummary();
    void loadStopped();
    if (store().zones.status !== "ready") void loadZones();
  };

  const callbacks: FleetStreamCallbacks = {
    onSnapshot(snapshot) {
      if (stopped) return;
      pending = [];
      clearTimeout(flushTimer);
      flushTimer = undefined;
      store().applySnapshot(snapshot, now());
      resync();
    },
    onVehicleState(state) {
      if (!stopped) enqueue({ type: "vehicle.state", state });
    },
    onAlert(alert) {
      if (stopped) return;
      enqueue({ type: "alert", alert });
      summaryTimer ??= setTimeout(() => {
        summaryTimer = undefined;
        if (!stopped) void loadSummary();
      }, summaryDebounceMs);
    },
    onStatus(status) {
      if (!stopped) store().setConnection(status);
    },
    onUnauthorized() {
      if (!stopped) options.onUnauthorized();
    },
  };

  return {
    start() {
      if (stream !== null || stopped) return;
      // KPIs, detenidos y zonas no los reemplaza el snapshot: se piden ya, para que el panel tenga datos aunque el stream tarde o falle.
      void loadZones();
      void loadSummary();
      void loadStopped();
      stream = options.openStream(callbacks);
      stream.start();
      // Siempre, también con el stream caído: si la API tampoco responde, el panel muestra el dato anterior con su hora y el error.
      refreshTimer = setInterval(() => {
        void loadSummary();
        void loadStopped();
      }, refreshMs);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      stream?.stop();
      clearTimeout(flushTimer);
      clearTimeout(summaryTimer);
      clearInterval(refreshTimer);
      controller.abort();
      pending = [];
    },
  };
}
