import type { Logger } from "@fleet/platform";
import { z } from "zod";
import type { BatchHandler } from "./telemetry-batch-handler.js";

/**
 * Evento de instrumentación de kafkajs tal como lo entrega `consumer.on`: el `payload` es `unknown` y cada listener lo
 * estrecha con su esquema (sin casts). Es lo bastante ancho para que el `Consumer` real lo cumpla.
 */
export interface ConsumerEvent {
  readonly type: string;
  readonly payload: unknown;
}

const groupJoinPayload = z.object({ memberAssignment: z.record(z.string(), z.array(z.number())) });
const crashPayload = z.object({ error: z.instanceof(Error), groupId: z.string(), restart: z.boolean() });
const batchPayload = z.object({ topic: z.string(), partition: z.number(), offsetLag: z.string(), batchSize: z.number() });

/**
 * Lo único que el runner usa de un `Consumer` de kafkajs: el consumer real lo cumple, y los tests lo implementan
 * sin casts.
 */
export interface ConsumerPort {
  readonly events: { readonly GROUP_JOIN: string; readonly REBALANCING: string; readonly CRASH: string; readonly START_BATCH_PROCESS: string };
  on(event: string, listener: (event: ConsumerEvent) => void): unknown;
  connect(): Promise<void>;
  subscribe(subscription: { topic: string; fromBeginning: boolean }): Promise<void>;
  run(config: { autoCommit: boolean; eachBatchAutoResolve: boolean; eachBatch: BatchHandler }): Promise<void>;
  stop(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface TelemetryConsumerOptions {
  consumer: ConsumerPort;
  topic: string;
  groupId: string;
  handler: BatchHandler;
  logger: Pick<Logger, "info" | "debug" | "warn" | "error">;
  /**
   * El consumer se cayó y kafkajs NO lo va a reiniciar (`restart: false`): el proceso seguiría vivo y sano para el
   * orquestador, pero sin consumir. Quien compone (`main.ts`) apaga el proceso con código 1 para que lo reinicie.
   */
  onFatal: (reason: string) => void;
}

export interface TelemetryConsumerRunner {
  /** Conecta, se suscribe y empieza a consumir. */
  start(): Promise<void>;
  /** Deja de consumir, espera a que termine el mensaje en vuelo y desconecta. */
  stop(): Promise<void>;
}

/**
 * Ciclo de vida del consumer de `telemetry.raw`: solo conecta y delega cada lote de una partición en `handler`. No parsea
 * ni decide nada (regla 2): el parseo con el contrato, la persistencia y la DLQ son del caso de uso.
 *
 * - `fromBeginning: true`: un grupo nuevo no se salta lo que ya hay en el tópico. Con un sumidero idempotente, releer es
 *   inofensivo; saltarse mensajes, no.
 * - `eachBatchAutoResolve: false`: kafkajs NO marca como procesado el último offset del lote al volver el handler. Solo
 *   avanza lo que el caso de uso resuelve con `resolveOffset`, y eso ocurre únicamente después de persistir y de
 *   confirmar la DLQ del tramo (regla 6: commit solo después de persistir). Si el handler lanza o deja de procesar a
 *   medias, lo no resuelto se reentrega.
 * - `autoCommit: true`: kafkajs confirma, tras cada lote y cuando un lote falla, SOLO los offsets ya resueltos. Además, el
 *   caso de uso confirma cada tramo con offsets explícitos (ver `createTelemetryBatchHandler`). Sigue siendo at-least-once:
 *   el commit llega después de la persistencia y el sumidero es idempotente.
 * - Si el handler lanza (base caída tras los reintentos, DLQ sin confirmar), kafkajs reinicia el consumer y reentrega,
 *   mientras le queden reintentos. Si se agotan, emite `CRASH` con `restart: false` y el consumer queda muerto: se registra
 *   un error y se llama a `onFatal` para que el proceso termine y el orquestador lo reinicie. Con `restart: true` kafkajs ya
 *   lo reinicia y solo se avisa.
 * - Por cada lote se registra el lag de la partición (`START_BATCH_PROCESS`): solo números, nunca el contenido.
 * - `stop()` espera a que el `eachBatch` en curso termine antes de desconectar (kafkajs lo garantiza al detener el
 *   consumer), así no se pierde ni se duplica trabajo a medias.
 */
export function createTelemetryConsumerRunner(options: TelemetryConsumerOptions): TelemetryConsumerRunner {
  const { consumer, topic, groupId, handler, logger, onFatal } = options;

  return {
    async start() {
      consumer.on(consumer.events.GROUP_JOIN, (event) => {
        const parsed = event.type === "consumer.group_join" ? groupJoinPayload.safeParse(event.payload) : undefined;
        if (parsed?.success !== true) return;
        logger.info({ groupId, partitions: parsed.data.memberAssignment[topic] ?? [] }, "Consumer unido al grupo");
      });
      consumer.on(consumer.events.REBALANCING, () => {
        logger.warn({ groupId }, "Rebalanceo del grupo en curso");
      });
      consumer.on(consumer.events.CRASH, (event) => {
        if (event.type !== "consumer.crash") return;
        // Falla en cerrado: si el payload no se puede leer no se sabe si kafkajs reiniciará el consumer, y es preferible
        // reiniciar el proceso a dejarlo vivo y sin consumir.
        const parsed = crashPayload.safeParse(event.payload);
        if (parsed.success && parsed.data.restart) {
          logger.warn({ groupId, err: parsed.data.error }, "El consumer se cayó y kafkajs lo reinicia");
          return;
        }
        logger.error({ groupId, ...(parsed.success && { err: parsed.data.error }) }, "El consumer se cayó y kafkajs NO lo reinicia: se apaga el proceso para que el orquestador lo reinicie");
        onFatal("el consumer de Kafka se cayó sin reinicio");
      });
      consumer.on(consumer.events.START_BATCH_PROCESS, (event) => {
        const parsed = event.type === "consumer.start_batch_process" ? batchPayload.safeParse(event.payload) : undefined;
        if (parsed?.success !== true) return;
        const { topic: batchTopic, partition, offsetLag, batchSize } = parsed.data;
        logger.debug({ groupId, topic: batchTopic, partition, offsetLag, batchSize }, "Lote de telemetría recibido (lag de la partición)");
      });

      await consumer.connect();
      await consumer.subscribe({ topic, fromBeginning: true });
      await consumer.run({ autoCommit: true, eachBatchAutoResolve: false, eachBatch: handler });
      logger.info({ groupId, topic }, "Consumer suscrito");
    },

    async stop() {
      await consumer.stop();
      await consumer.disconnect();
    },
  };
}
