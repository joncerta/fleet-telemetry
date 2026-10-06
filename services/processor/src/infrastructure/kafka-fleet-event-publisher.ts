import { alertEventSchema, TOPICS, vehicleStateEventSchema } from "@fleet/contracts";
import { DEFAULT_MAX_BATCH_BYTES, splitBySize, withCorrelationId, type FleetMessage, type FleetProducer } from "@fleet/platform";
import type { FleetEventPublisher, KeyedEvent } from "../application/ports.js";
import { withTimeout } from "./publish-timeout.js";

export interface KafkaFleetEventPublisherOptions {
  /** Productor del proceso (idempotente, `acks=-1`). Solo se usa `sendBatch`. */
  producer: Pick<FleetProducer, "sendBatch">;
  /**
   * Tiempo máximo de TODA la publicación, y también el `timeout` de cada petición al broker. Pasado ese tiempo se da por fallida: el caso
   * de uso no resuelve el offset del tramo y kafkajs reentrega el lote, que republica el estado vigente (los consumidores descartan los
   * repetidos por `seq`).
   */
  timeoutMs: number;
  /** Tope de bytes de cada `sendBatch`. Por defecto `DEFAULT_MAX_BATCH_BYTES` (la mitad del 1 MiB del broker). */
  maxBatchBytes?: number;
  /** Nombres de los tópicos. Por defecto los reales; los tests de integración usan temporales. */
  topics?: { readonly vehicleState: string; readonly fleetAlerts: string };
}

/**
 * Valida el evento con el esquema ESTRICTO del contrato antes de enviarlo (un productor no emite lo que su propio contrato rechaza) y
 * lo convierte en un mensaje de Kafka: key = `vehicleId` y header `correlationId` del mensaje original.
 */
function toMessage<T>(entry: KeyedEvent<T>, schema: { parse(input: unknown): T }): FleetMessage {
  return {
    key: entry.key,
    value: JSON.stringify(schema.parse(entry.event)),
    headers: withCorrelationId(undefined, entry.correlationId),
  };
}

/**
 * Adaptador de `FleetEventPublisher` sobre el productor de la plataforma. Publica primero `vehicle.state` y luego `fleet.alerts`; cada
 * tópico en sub-lotes de a lo sumo `maxBatchBytes` (`splitBySize`), de a uno y en orden (un tramo de cientos de vehículos puede superar el
 * 1 MiB que acepta el broker). Si un sub-lote falla, los siguientes no se envían y la llamada rechaza. El productor es el único del proceso.
 */
export function createKafkaFleetEventPublisher(options: KafkaFleetEventPublisherOptions): FleetEventPublisher {
  const topics = options.topics ?? { vehicleState: TOPICS.vehicleState, fleetAlerts: TOPICS.fleetAlerts };
  const maxBatchBytes = options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES;

  return {
    // `async`: un evento inválido o un correlationId inválido también llegan como rechazo, no como lanzamiento síncrono.
    publish: async ({ vehicleStates, alerts }) => {
      const byTopic: { topic: string; messages: FleetMessage[] }[] = [
        { topic: topics.vehicleState, messages: vehicleStates.map((entry) => toMessage(entry, vehicleStateEventSchema)) },
        { topic: topics.fleetAlerts, messages: alerts.map((entry) => toMessage(entry, alertEventSchema)) },
      ];
      await withTimeout(async (isAbandoned) => {
        for (const { topic, messages } of byTopic) {
          for (const subBatch of splitBySize(messages, maxBatchBytes)) {
            if (isAbandoned()) return;
            await options.producer.sendBatch({ topicMessages: [{ topic, messages: subBatch }], timeout: options.timeoutMs });
          }
        }
      }, options.timeoutMs);
    },
  };
}
