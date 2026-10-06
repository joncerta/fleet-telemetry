import {
  SSE_EVENTS,
  sseAlertTolerantSchema,
  sseSnapshotTolerantSchema,
  sseVehicleStateTolerantSchema,
  type AlertTolerant,
  type SseSnapshotTolerant,
  type VehicleStateTolerant,
} from "@fleet/contracts";
import type { z } from "zod";
import type { LogFn } from "../../lib/log";
import { backoffDelayMs, STREAM_BACKOFF, type BackoffPolicy } from "./backoff";

/** Estado de la conexión que ve el usuario: en vivo, reconectando o desconectado (tras varios intentos fallidos seguidos). */
export type ConnectionStatus = "connecting" | "live" | "reconnecting" | "disconnected";

/** Lo que el cliente necesita de `EventSource` (el del navegador lo cumple; los tests usan uno falso). */
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: Event) => void): void;
  close(): void;
}
export type EventSourceFactory = (url: string) => EventSourceLike;

/** Cookie de sesión de otro origen: `withCredentials`. Nunca un token en la URL. */
export const browserEventSource: EventSourceFactory = (url) => new EventSource(url, { withCredentials: true });

export type SessionProbe = () => Promise<"authenticated" | "unauthorized" | "unknown">;

export interface FleetStreamCallbacks {
  /** Primer evento de cada conexión: REEMPLAZA el estado. */
  onSnapshot(snapshot: SseSnapshotTolerant): void;
  onVehicleState(state: VehicleStateTolerant): void;
  onAlert(alert: AlertTolerant): void;
  onStatus(status: ConnectionStatus): void;
  /** La sesión venció o no existe: el stream se detiene y la app va al login. */
  onUnauthorized(): void;
}

export interface FleetStreamOptions {
  url: string;
  createEventSource: EventSourceFactory;
  /**
   * `EventSource` no expone el código HTTP de un fallo: un 401 y un 500 se ven igual. Cuando una conexión falla antes de su snapshot,
   * se pregunta a `/v1/auth/session` si la sesión sigue viva.
   */
  probeSession: SessionProbe;
  /** Latido del servidor (`SSE_HEARTBEAT_MS`, 15 s por defecto). Sin ninguna señal en 2 latidos, la conexión se da por muerta. */
  heartbeatMs: number;
  backoff?: BackoffPolicy;
  /** [0, 1), para el jitter. Inyectable en los tests. */
  random?: () => number;
  /** Fallos seguidos a partir de los cuales el estado pasa de "reconectando" a "desconectado". */
  disconnectedAfterFailures?: number;
  /** Registro SIN datos personales: nombre del evento y rutas de los campos inválidos, nunca el payload. */
  log?: LogFn;
}

export interface FleetStreamHandle {
  start(): void;
  /** Cierra la conexión y cancela los temporizadores. Idempotente. */
  stop(): void;
  /** Reconecta ya, sin esperar el backoff (p. ej. el navegador volvió a tener red). No hace nada si la conexión está viva. */
  reconnectNow(): void;
}

const DEAD_AFTER_HEARTBEATS = 2;

/**
 * El ÚNICO cliente del stream SSE de fleet-api (`GET /v1/stream`).
 *
 * - **Snapshot primero.** El servidor lo garantiza en cada conexión; los eventos que llegaran antes se ignoran (el snapshot los incluye).
 * - **Validación.** Cada evento se valida con la variante tolerante de `@fleet/contracts`; uno inválido se descarta y se registra sin el
 *   payload, sin romper la UI.
 * - **Reconexión manual con backoff y jitter** ante cualquier error: se cierra el `EventSource` (su reintento propio es a intervalo fijo,
 *   sin jitter) y se reabre con `backoffDelayMs`. Cada reconexión trae un snapshot nuevo, que reemplaza el estado (el servidor ignora
 *   `Last-Event-ID`).
 * - **Conexión muerta.** Sin ninguna señal durante 2 latidos se cierra y se reconecta. OJO: el latido del servidor es un comentario SSE
 *   (`: heartbeat`), que `EventSource` NO entrega a JavaScript; hoy cuentan como señal la apertura y los eventos con nombre.
 * - **401.** Si una conexión falla antes de su snapshot, se consulta la sesión; si no hay, se detiene y avisa `onUnauthorized`.
 */
export function createFleetStream(options: FleetStreamOptions, callbacks: FleetStreamCallbacks): FleetStreamHandle {
  const random = options.random ?? Math.random;
  const backoff = options.backoff ?? STREAM_BACKOFF;
  const disconnectedAfter = options.disconnectedAfterFailures ?? 3;
  const log = options.log ?? (() => undefined);

  let source: EventSourceLike | null = null;
  let started = false;
  let stopped = false;
  /** Intentos fallidos seguidos desde el último snapshot: elige la espera y el estado que se muestra. */
  let failures = 0;
  let everLive = false;
  /** Generación de la conexión actual: los callbacks de una conexión ya cerrada no hacen nada. */
  let generation = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
  let status: ConnectionStatus | null = null;

  const setStatus = (next: ConnectionStatus) => {
    if (status === next) return;
    status = next;
    callbacks.onStatus(next);
  };

  const clearWatchdog = () => {
    clearTimeout(watchdogTimer);
    watchdogTimer = undefined;
  };

  const closeSource = () => {
    clearWatchdog();
    generation += 1;
    source?.close();
    source = null;
  };

  const scheduleReconnect = () => {
    if (stopped) return;
    const delay = backoffDelayMs(failures - 1, random, backoff);
    setStatus(failures >= disconnectedAfter ? "disconnected" : "reconnecting");
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, delay);
  };

  const fail = (reason: string, beforeSnapshot: boolean) => {
    if (stopped) return;
    closeSource();
    failures += 1;
    log("Stream SSE interrumpido", { reason, failures });
    if (!beforeSnapshot) {
      scheduleReconnect();
      return;
    }
    setStatus(failures >= disconnectedAfter ? "disconnected" : everLive ? "reconnecting" : "connecting");
    const probedGeneration = generation;
    void options
      .probeSession()
      .catch(() => "unknown" as const)
      .then((session) => {
        if (stopped || probedGeneration !== generation) return;
        if (session === "unauthorized") {
          stop();
          callbacks.onUnauthorized();
          return;
        }
        scheduleReconnect();
      });
  };

  function connect(): void {
    if (stopped) return;
    clearTimeout(reconnectTimer);
    closeSource();
    const current = generation;
    let snapshotSeen = false;
    const isCurrent = () => !stopped && current === generation;

    const armWatchdog = () => {
      clearWatchdog();
      watchdogTimer = setTimeout(() => {
        if (isCurrent()) fail("sin señal del servidor", !snapshotSeen);
      }, DEAD_AFTER_HEARTBEATS * options.heartbeatMs);
    };

    const parse = <S extends z.ZodType>(event: Event, name: string, schema: S): z.output<S> | null => {
      const raw = (event as MessageEvent<unknown>).data;
      let json: unknown;
      try {
        json = typeof raw === "string" ? JSON.parse(raw) : undefined;
      } catch {
        json = undefined;
      }
      const result = schema.safeParse(json);
      if (result.success) return result.data;
      log("Evento SSE inválido descartado", { event: name, issues: result.error.issues.map((issue) => issue.path.join(".")) });
      return null;
    };

    source = options.createEventSource(options.url);
    const es = source;
    if (status === null) setStatus("connecting");
    // Desde ya: una conexión que nunca abre (el servidor acepta el socket y no responde) también se da por muerta.
    armWatchdog();

    es.addEventListener("open", () => {
      if (isCurrent()) armWatchdog();
    });

    es.addEventListener(SSE_EVENTS.snapshot, (event) => {
      if (!isCurrent()) return;
      armWatchdog();
      const snapshot = parse(event, SSE_EVENTS.snapshot, sseSnapshotTolerantSchema);
      if (snapshot === null) {
        // Sin un snapshot válido no hay base sobre la que aplicar eventos: se reintenta la conexión.
        fail("snapshot inválido", true);
        return;
      }
      snapshotSeen = true;
      failures = 0;
      everLive = true;
      callbacks.onSnapshot(snapshot);
      setStatus("live");
    });

    es.addEventListener(SSE_EVENTS.vehicleState, (event) => {
      if (!isCurrent()) return;
      armWatchdog();
      if (!snapshotSeen) return;
      const data = parse(event, SSE_EVENTS.vehicleState, sseVehicleStateTolerantSchema);
      if (data !== null) callbacks.onVehicleState(data.state);
    });

    es.addEventListener(SSE_EVENTS.alert, (event) => {
      if (!isCurrent()) return;
      armWatchdog();
      if (!snapshotSeen) return;
      const data = parse(event, SSE_EVENTS.alert, sseAlertTolerantSchema);
      if (data !== null) callbacks.onAlert(data.alert);
    });

    es.addEventListener("error", () => {
      if (isCurrent()) fail("error de la conexión", !snapshotSeen);
    });
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearTimeout(reconnectTimer);
    closeSource();
  }

  return {
    start() {
      if (started || stopped) return;
      started = true;
      connect();
    },
    stop,
    reconnectNow() {
      if (!started || stopped || status === "live" || source !== null) return;
      connect();
    },
  };
}
