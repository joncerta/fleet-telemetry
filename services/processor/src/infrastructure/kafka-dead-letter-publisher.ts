import { TOPICS } from "@fleet/contracts";
import { DEFAULT_MAX_BATCH_BYTES, splitBySize, withCorrelationId, type FleetMessage, type FleetProducer } from "@fleet/platform";
import type { DeadLetterPublisher } from "../application/ports.js";

export class PublishTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`El broker no confirmó la publicación en ${timeoutMs} ms.`);
    this.name = "PublishTimeoutError";
  }
}

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
 * Adaptador de `DeadLetterPublisher` sobre el productor de la plataforma: un solo `sendBatch` por llamada (no un `send`
 * por mensaje). Key = la que decide el caso de uso (`vehicleId` si se conoce), header `correlationId` en cada mensaje.
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

/**
 * Rechaza con `PublishTimeoutError` si `work` no termina a tiempo (todos los sub-lotes juntos). El temporizador se cancela
 * siempre. `work` recibe `isAbandoned`: tras el vencimiento devuelve `true` y debe dejar de iniciar envíos nuevos.
 */
async function withTimeout(work: (isAbandoned: () => boolean) => Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  let abandoned = false;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abandoned = true;
      reject(new PublishTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  try {
    await Promise.race([work(() => abandoned), expired]);
  } finally {
    clearTimeout(timer);
  }
}
