import { TOPICS } from "@fleet/contracts";
import { DEFAULT_MAX_BATCH_BYTES, splitBySize, withCorrelationId, type FleetMessage, type FleetProducer } from "@fleet/platform";
import type { DeadLetterPublisher } from "../application/ports.js";
import { PublishTimeoutError, withTimeout } from "./publish-timeout.js";

// El error y el temporizador son compartidos con el publicador de eventos de la flota; se reexporta el error para quien ya lo importa de aquí.
export { PublishTimeoutError };

export interface KafkaDeadLetterPublisherOptions {
  /** Productor del proceso (idempotente, `acks=-1`). Solo se usa `sendBatch`. */
  producer: Pick<FleetProducer, "sendBatch">;
  /**
   * Tiempo máximo de la publicación, y también el `timeout` de la petición al broker. Pasado ese tiempo se da por fallida:
   * el caso de uso no resuelve el offset del tramo y kafkajs reentrega el lote. El envío ya iniciado puede terminar de
   * llegar al broker; la DLQ puede entonces repetir un mensaje, y se acepta (es una bandeja de inspección).
   */
  timeoutMs: number;
  /** Tope de bytes de cada `sendBatch`. Por defecto `DEFAULT_MAX_BATCH_BYTES` (la mitad del 1 MiB del broker). */
  maxBatchBytes?: number;
  /** Nombre del tópico. Por defecto el real; los tests de integración usan uno temporal. */
  topic?: string;
}

/**
 * Adaptador de `DeadLetterPublisher` sobre el productor de la plataforma. Parte la publicación en sub-lotes de a lo sumo
 * `maxBatchBytes` (`splitBySize`) y envía un `sendBatch` por sub-lote, de a uno y en orden (no un `send` por mensaje): un
 * tramo entero de rechazos puede superar el 1 MiB que acepta el broker. Si un sub-lote falla, los siguientes no se envían y la
 * llamada rechaza. Key = la que decide el caso de uso (`vehicleId` si se conoce), header `correlationId` en cada mensaje.
 */
export function createKafkaDeadLetterPublisher(options: KafkaDeadLetterPublisherOptions): DeadLetterPublisher {
  const topic = options.topic ?? TOPICS.telemetryDlq;
  const maxBatchBytes = options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES;

  return {
    // `async`: un correlationId inválido (CorrelationIdError) también llega como rechazo, no como lanzamiento síncrono.
    publish: async (entries) => {
      if (entries.length === 0) return;
      const messages: FleetMessage[] = entries.map((entry) => ({
        key: entry.key,
        value: JSON.stringify(entry.message),
        headers: withCorrelationId(undefined, entry.correlationId),
      }));
      await withTimeout(async (isAbandoned) => {
        for (const subBatch of splitBySize(messages, maxBatchBytes)) {
          if (isAbandoned()) return;
          await options.producer.sendBatch({ topicMessages: [{ topic, messages: subBatch }], timeout: options.timeoutMs });
        }
      }, options.timeoutMs);
    },
  };
}
