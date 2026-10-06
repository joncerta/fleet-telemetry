import { alertEventTolerantSchema, SSE_EVENTS, vehicleStateEventTolerantSchema } from "@fleet/contracts";
import { getCorrelationId, type Logger } from "@fleet/platform";
import type { FleetStreamEvent } from "../../domain/stream-ordering.js";

/** Evento de instrumentación de kafkajs tal como lo entrega `consumer.on`: el `payload` es `unknown` y cada listener lo estrecha con su esquema. */
export interface FeedConsumerEvent {
  readonly type: string;
  readonly payload: unknown;
}

/** Mensaje de Kafka, solo con lo que el feed lee. El `Consumer` real de kafkajs lo cumple. */
export interface FeedMessage {
  readonly topic: string;
  readonly partition: number;
  readonly message: {
    readonly offset: string;
    readonly value: Buffer | null;
    readonly headers?: Record<string, Buffer | string | (Buffer | string)[] | undefined> | undefined;
  };
}

/** Lo único que el feed usa de un `Consumer` de kafkajs: el real lo cumple y los tests lo implementan sin casts. */
export interface FeedConsumerPort {
  readonly events: { readonly GROUP_JOIN: string; readonly REBALANCING: string; readonly CRASH: string };
  on(event: string, listener: (event: FeedConsumerEvent) => void): unknown;
  connect(): Promise<void>;
  subscribe(subscription: { topic: string; fromBeginning: boolean }): Promise<void>;
  run(config: { autoCommit: boolean; autoCommitInterval: number; eachMessage: (payload: FeedMessage) => Promise<void> }): Promise<void>;
  stop(): Promise<void>;
  disconnect(): Promise<void>;
}

/**
 * Cada cuánto se confirma la posición del grupo. Solo sirve para que un reinicio interno de kafkajs (o del proceso con el mismo
 * `FLEET_API_INSTANCE_ID`) retome cerca de donde iba y no desde el final: lo repetido se descarta por `seq`. No se confirma por mensaje (un
 * viaje al broker por evento no aporta nada a un read model).
 */
export const FEED_AUTO_COMMIT_INTERVAL_MS = 5_000;

export interface FleetEventFeedOptions {
  consumer: FeedConsumerPort;
  /** Grupo ÚNICO de esta réplica (`fleet-api-sse-<instancia>`): nunca compartido, para que cada réplica reciba todos los eventos (regla 6). */
  groupId: string;
  topics: { readonly vehicleState: string; readonly fleetAlerts: string };
  /** A quién se entrega cada evento válido (el hub en memoria del caso de uso). */
  publish: (tenantId: string, event: FleetStreamEvent) => void;
  logger: Pick<Logger, "info" | "warn" | "error" | "debug">;
}

export interface FleetEventFeed {
  /** Conecta, se suscribe (desde el final) y empieza a consumir. Al resolver, el feed está listo. */
  start(): Promise<void>;
  /** Deja de consumir, espera al mensaje en vuelo y desconecta. */
  stop(): Promise<void>;
  /** `true` si el consumer está unido al grupo y consumiendo (sonda de `/health`). */
  isReady(): boolean;
}

/**
 * Consumer de `vehicle.state` y `fleet.alerts` que alimenta el SSE de ESTA réplica. fleet-api es un read model: no persiste ni reintenta nada.
 *
 * - **Grupo único por réplica, desde el final.** Un grupo nuevo no tiene offsets y `fromBeginning: false` lo posiciona en el final en su primer
 *   fetch: no hay historia que reprocesar. Entre unirse al grupo y ese primer fetch hay una ventana de milisegundos en la que un evento no se
 *   vería; no importa, porque el servidor no acepta streams hasta que `start()` resuelve y cada stream lee su snapshot DESPUÉS (ADR-009).
 * - **Parseo con los esquemas TOLERANTES** del contrato (un enum nuevo llega como `"unknown"`, una `schemaVersion` futura se lee). Un mensaje
 *   inválido se registra (tópico, partición y offset; nunca el contenido: lleva posición y placa) y se descarta: no hay DLQ, no detiene la partición.
 * - `eachMessage` nunca lanza: lo que falle al repartir no puede hacer que kafkajs reinicie el consumer.
 * - El `tenantId` sale del PAYLOAD validado del evento, no de la key ni de headers.
 */
export function createFleetEventFeed(options: FleetEventFeedOptions): FleetEventFeed {
  const { consumer, groupId, topics, publish, logger } = options;
  let ready = false;
  let started = false;

  const handle = ({ topic, partition, message }: FeedMessage): void => {
    const where = { topic, partition, offset: message.offset };
    let value: unknown;
    try {
      value = JSON.parse(message.value?.toString() ?? "null");
    } catch {
      logger.warn(where, "Mensaje descartado: no es JSON");
      return;
    }

    if (topic === topics.vehicleState) {
      const parsed = vehicleStateEventTolerantSchema.safeParse(value);
      if (!parsed.success) {
        logger.warn({ ...where, issues: parsed.error.issues.map((issue) => issue.path.join(".")) }, "Mensaje descartado: no cumple el contrato de vehicle.state");
        return;
      }
      logger.debug({ ...where, tenantId: parsed.data.tenantId, vehicleId: parsed.data.state.vehicleId, correlationId: getCorrelationId(message.headers) }, "vehicle.state recibido");
      publish(parsed.data.tenantId, { type: SSE_EVENTS.vehicleState, state: parsed.data.state });
      return;
    }

    if (topic === topics.fleetAlerts) {
      const parsed = alertEventTolerantSchema.safeParse(value);
      if (!parsed.success) {
        logger.warn({ ...where, issues: parsed.error.issues.map((issue) => issue.path.join(".")) }, "Mensaje descartado: no cumple el contrato de fleet.alerts");
        return;
      }
      logger.debug({ ...where, tenantId: parsed.data.tenantId, vehicleId: parsed.data.alert.vehicleId, correlationId: getCorrelationId(message.headers) }, "fleet.alerts recibido");
      publish(parsed.data.tenantId, { type: SSE_EVENTS.alert, alert: parsed.data.alert });
    }
  };

  return {
    async start() {
      consumer.on(consumer.events.GROUP_JOIN, (event) => {
        if (event.type !== "consumer.group_join" || !started) return;
        ready = true;
        logger.info({ groupId }, "Consumer del SSE unido al grupo");
      });
      consumer.on(consumer.events.REBALANCING, () => {
        ready = false;
        logger.warn({ groupId }, "Rebalanceo del grupo del SSE en curso");
      });
      consumer.on(consumer.events.CRASH, (event) => {
        if (event.type !== "consumer.crash") return;
        ready = false;
        logger.error({ groupId }, "El consumer del SSE se cayó: /health lo reporta caído hasta que kafkajs lo reinicie");
      });

      await consumer.connect();
      await consumer.subscribe({ topic: topics.vehicleState, fromBeginning: false });
      await consumer.subscribe({ topic: topics.fleetAlerts, fromBeginning: false });
      await consumer.run({
        autoCommit: true,
        autoCommitInterval: FEED_AUTO_COMMIT_INTERVAL_MS,
        eachMessage: (payload) => {
          try {
            handle(payload);
          } catch (err) {
            logger.error({ topic: payload.topic, partition: payload.partition, offset: payload.message.offset, err }, "Falló el reparto de un evento al SSE");
          }
          return Promise.resolve();
        },
      });
      // `run` resuelve cuando el consumer ya se unió al grupo y tiene sus particiones.
      started = true;
      ready = true;
      logger.info({ groupId, topics: [topics.vehicleState, topics.fleetAlerts] }, "Consumer del SSE suscrito");
    },

    async stop() {
      ready = false;
      await consumer.stop();
      await consumer.disconnect();
    },

    isReady: () => ready,
  };
}
