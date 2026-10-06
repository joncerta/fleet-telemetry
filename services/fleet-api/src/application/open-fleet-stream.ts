import { SSE_EVENTS } from "@fleet/contracts";
import type { Logger } from "@fleet/platform";
import type { AuthIdentity } from "../domain/identity.js";
import { createSeqTracker, seqOf, snapshotCursor, type FleetStreamEvent, type SeqTracker } from "../domain/stream-ordering.js";
import type { Clock, FleetEventSubscriptions, FleetSnapshotReader, FleetStreamMessage, FleetStreamSink } from "./ports.js";

export interface OpenFleetStreamLimits {
  /** Streams simultáneos de un mismo usuario en esta réplica. El siguiente es rechazado. */
  readonly maxStreamsPerUser: number;
  /** Bytes sin leer en el socket a partir de los cuales el cliente se da por lento y se le corta (reconecta y recibe un snapshot nuevo). */
  readonly maxPendingBytes: number;
  /** Eventos que se guardan mientras se lee el snapshot. Pasado el tope se corta la conexión, que reconecta con un snapshot nuevo. */
  readonly maxBufferedEvents: number;
}

export interface OpenFleetStreamDeps {
  subscriptions: FleetEventSubscriptions;
  snapshots: FleetSnapshotReader;
  clock: Clock;
  logger: Pick<Logger, "info" | "warn">;
  limits: OpenFleetStreamLimits;
}

/** Quién abre el stream. La identidad sale de la sesión (regla 4), nunca de la petición. */
export interface OpenFleetStreamContext {
  readonly identity: AuthIdentity;
  readonly correlationId: string;
}

export type OpenFleetStreamResult =
  | { readonly status: "opened" }
  | { readonly status: "too_many_streams"; readonly limit: number }
  /** La réplica se está apagando (`closeAll` ya corrió): no se abren streams nuevos. El cliente reconecta a otra réplica. */
  | { readonly status: "draining" };

export type CloseReason = "open_failed" | "client_closed" | "slow_client" | "buffer_overflow" | "delivery_failed" | "shutdown";

export interface OpenFleetStream {
  /**
   * Abre el stream de la flota del tenant de `context.identity`. En este orden (regla 9, sin carreras):
   * 1. límite por usuario (antes de tocar nada: `too_many_streams` no deja rastro);
   * 2. se suscribe al tenant y BUFFERIZA lo que llegue;
   * 3. lee el snapshot (UNA transacción); si falla, se deshace todo y el error se propaga (la conexión aún no se ha entregado);
   * 4. `attach()` entrega la conexión (la entrada HTTP la desvincula de Fastify y escribe las cabeceras);
   * 5. envía `snapshot` con `id: cursor` como PRIMER evento;
   * 6. vacía el buffer entregando solo lo más nuevo que el snapshot, por vehículo y por alerta (`isNewerSeq`);
   * 7. sigue en vivo con `id: seq`. Los pasos 4 a 7 no tienen `await`: ningún evento se cuela entre el snapshot y el vaciado.
   */
  readonly open: (context: OpenFleetStreamContext, attach: () => FleetStreamSink) => Promise<OpenFleetStreamResult>;
  /**
   * Corta todos los streams abiertos (apagado ordenado: antes de cerrar el servidor HTTP, que no los espera) y pasa a estado DRAINING: los
   * `open` siguientes devuelven `draining` sin tocar nada. Sin esto, los clientes que acaban de ser cortados reconectan en el acto a esta misma
   * réplica, que sigue aceptando conexiones hasta cerrar el servidor, y el apagado nunca termina de vaciarse.
   */
  readonly closeAll: () => void;
}

const increment = (counts: Map<string, number>, key: string): number => {
  const next = (counts.get(key) ?? 0) + 1;
  counts.set(key, next);
  return next;
};

const decrement = (counts: Map<string, number>, key: string): number => {
  const next = (counts.get(key) ?? 1) - 1;
  if (next <= 0) counts.delete(key);
  else counts.set(key, next);
  return Math.max(next, 0);
};

/**
 * Caso de uso del stream SSE de la flota. No sabe de HTTP ni de Kafka: recibe eventos por `subscriptions` y escribe en un `FleetStreamSink`.
 *
 * Límites conocidos (documentados en ADR-009): `Last-Event-ID` no se usa, cada conexión empieza con un snapshot nuevo; y como `nextval` no es
 * monótono con el orden de commit, la comparación de `seq` es por vehículo y por alerta, no contra el `cursor` global.
 *
 * Logs: conteos por tenant y motivo de cierre; nunca placas ni posiciones (regla 14).
 */
export function createOpenFleetStream(deps: OpenFleetStreamDeps): OpenFleetStream {
  const { subscriptions, snapshots, clock, logger, limits } = deps;
  const streamsByUser = new Map<string, number>();
  const streamsByTenant = new Map<string, number>();
  const active = new Set<(reason: CloseReason) => void>();
  let draining = false;

  return {
    async open(context, attach) {
      const { userId, tenantId } = context.identity;
      if (draining) return { status: "draining" };
      if ((streamsByUser.get(userId) ?? 0) >= limits.maxStreamsPerUser) {
        logger.warn({ tenantId, correlationId: context.correlationId, limit: limits.maxStreamsPerUser }, "Stream SSE rechazado: límite por usuario");
        return { status: "too_many_streams", limit: limits.maxStreamsPerUser };
      }

      // El cupo se reserva ya: dos aperturas simultáneas del mismo usuario no pueden pasar ambas el límite mientras leen el snapshot.
      increment(streamsByUser, userId);
      increment(streamsByTenant, tenantId);

      type Phase = "buffering" | "live" | "closed";
      let phase: Phase = "buffering";
      let sink: FleetStreamSink | undefined;
      let tracker: SeqTracker | undefined;
      let overflowed = false;
      const buffer: FleetStreamEvent[] = [];
      let unsubscribe: () => void = () => undefined;

      const release = (reason: CloseReason): void => {
        if (phase === "closed") return;
        phase = "closed";
        unsubscribe();
        buffer.length = 0;
        active.delete(close);
        decrement(streamsByUser, userId);
        const tenantStreams = decrement(streamsByTenant, tenantId);
        logger.info({ tenantId, correlationId: context.correlationId, reason, tenantStreams, totalStreams: active.size }, "Stream SSE cerrado");
      };

      function close(reason: CloseReason): void {
        if (phase === "closed") return;
        release(reason);
        sink?.end();
      }

      const deliver = (message: FleetStreamMessage, checkBacklog: boolean): boolean => {
        if (sink === undefined || phase === "closed") return false;
        try {
          sink.deliver(message);
        } catch {
          close("delivery_failed");
          return false;
        }
        if (checkBacklog && sink.pendingBytes() > limits.maxPendingBytes) {
          close("slow_client");
          return false;
        }
        return true;
      };

      const deliverEvent = (event: FleetStreamEvent): boolean =>
        deliver(
          event.type === SSE_EVENTS.vehicleState
            ? { event: SSE_EVENTS.vehicleState, id: seqOf(event), data: { state: event.state } }
            : { event: SSE_EVENTS.alert, id: seqOf(event), data: { alert: event.alert } },
          true,
        );

      // 2) Suscribir y bufferizar ANTES de leer el snapshot: nada de lo que ocurra durante la lectura se pierde.
      unsubscribe = subscriptions.subscribe(tenantId, (event) => {
        if (phase === "closed") return;
        if (phase === "buffering") {
          if (buffer.length >= limits.maxBufferedEvents) overflowed = true;
          else buffer.push(event);
          return;
        }
        if (tracker?.accept(event) === true) deliverEvent(event);
      });

      let snapshotMessage: FleetStreamMessage;
      try {
        // 3) El snapshot, de una transacción.
        const data = await snapshots.read(tenantId);
        const cursor = snapshotCursor(data.vehicles, data.alerts);
        // El apagado empezó mientras se leía el snapshot: no se entrega la conexión (la entrada HTTP aún puede responder 503 sin `hijack`).
        if (draining) {
          release("shutdown");
          return { status: "draining" };
        }
        tracker = createSeqTracker(data);
        snapshotMessage = {
          event: SSE_EVENTS.snapshot,
          id: cursor,
          data: { serverTime: clock.now().toISOString(), cursor, vehicles: [...data.vehicles], alerts: [...data.alerts] },
        };
        // 4) Desde aquí la conexión es nuestra.
        sink = attach();
      } catch (err) {
        release("open_failed");
        throw err;
      }

      active.add(close);
      sink.onClose(() => close("client_closed"));
      logger.info({ tenantId, correlationId: context.correlationId, tenantStreams: streamsByTenant.get(tenantId) ?? 0, totalStreams: active.size }, "Stream SSE abierto");

      // 5) El snapshot, primero. Un snapshot grande no cuenta como cliente lento (checkBacklog = false): su peso lo ve el siguiente evento.
      if (!deliver(snapshotMessage, false)) return { status: "opened" };

      // 6) Vaciar el buffer: solo lo más nuevo que el snapshot, por vehículo y por alerta.
      if (overflowed) {
        close("buffer_overflow");
        return { status: "opened" };
      }
      const pending = buffer.splice(0);
      phase = "live";
      for (const event of pending) {
        if (tracker.accept(event) && !deliverEvent(event)) break;
      }
      return { status: "opened" };
    },

    closeAll() {
      draining = true;
      for (const close of [...active]) close("shutdown");
    },
  };
}
