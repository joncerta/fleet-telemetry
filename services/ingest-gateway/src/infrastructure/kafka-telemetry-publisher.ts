import { TOPICS, type TelemetryDlqMessage, type TelemetryRawEvent } from "@fleet/contracts";
import { DEFAULT_MAX_BATCH_BYTES, splitBySize, withCorrelationId, type FleetMessage, type FleetProducer } from "@fleet/platform";
import { PublicationFailedError, type PublicationTarget } from "../application/errors.js";
import type { PublishContext, TelemetryPublisher } from "../application/ports.js";

export class PublishTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`El broker no confirmó la publicación en ${timeoutMs} ms.`);
    this.name = "PublishTimeoutError";
  }
}

/** Hay demasiados envíos a Kafka en vuelo: no se llama a kafkajs. Es la `cause` del `PublicationFailedError`. */
export class PublishBacklogError extends Error {
  constructor(readonly maxInFlight: number) {
    super(`Hay ${maxInFlight} envíos a Kafka en vuelo: no se aceptan más hasta que termine alguno.`);
    this.name = "PublishBacklogError";
  }
}

export interface KafkaTelemetryPublisherOptions {
  /** Productor del proceso (idempotente, `acks=-1`). Solo se usa `sendBatch`. */
  producer: Pick<FleetProducer, "sendBatch">;
  /**
   * Tiempo máximo de cada publicación (todos sus sub-lotes), y también el `timeout` de cada petición al broker. Pasado ese
   * tiempo la publicación se da por fallida (el lote responde 503 y el móvil reintenta); el envío ya iniciado puede terminar
   * de llegar al broker, y es seguro porque la persistencia es idempotente. Los sub-lotes que faltaban no se envían.
   */
  timeoutMs: number;
  /**
   * Envíos a kafkajs en vuelo como máximo. Un envío cuenta hasta que kafkajs lo resuelve o lo rechaza, NO hasta que vence su
   * timeout: el timeout abandona la espera, no cancela el envío. Por encima de este número se lanza `PublicationFailedError`
   * sin llamar a kafkajs, para que un broker lento no acumule envíos huérfanos sin límite.
   */
  maxInFlight: number;
  /** Tope de bytes de cada `sendBatch`. Por defecto `DEFAULT_MAX_BATCH_BYTES`. */
  maxBatchBytes?: number;
  /** Nombres de los tópicos. Por defecto los reales; los tests de integración usan tópicos temporales. */
  topics?: { raw: string; dlq: string };
}

/**
 * Adaptador de `TelemetryPublisher` sobre el productor de la plataforma. Un `sendBatch` por tópico y por petición (no un
 * `send` por punto), salvo que el lote supere `maxBatchBytes`: entonces se parte en sub-lotes que se envían de a uno, en
 * orden. Key = `vehicleId` del token, header `correlationId` en todos los mensajes.
 */
export function createKafkaTelemetryPublisher(options: KafkaTelemetryPublisherOptions): TelemetryPublisher {
  const topics = options.topics ?? { raw: TOPICS.telemetryRaw, dlq: TOPICS.telemetryDlq };
  const maxBatchBytes = options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES;
  let inFlight = 0;

  /** Cuenta el envío mientras kafkajs no lo resuelva, aunque quien lo pidió ya haya dejado de esperar. */
  async function sendTracked(topic: string, messages: FleetMessage[]): Promise<void> {
    inFlight += 1;
    try {
      await options.producer.sendBatch({ topicMessages: [{ topic, messages }], timeout: options.timeoutMs });
    } finally {
      inFlight -= 1;
    }
  }

  const publish = (target: PublicationTarget, topic: string, messages: FleetMessage[]): Promise<void> =>
    withTimeout(async (isAbandoned) => {
      for (const subBatch of splitBySize(messages, maxBatchBytes)) {
        if (isAbandoned()) return;
        if (inFlight >= options.maxInFlight) throw new PublicationFailedError([target], new PublishBacklogError(options.maxInFlight));
        await sendTracked(topic, subBatch);
      }
    }, options.timeoutMs);

  const toMessage = (context: PublishContext, value: TelemetryRawEvent | TelemetryDlqMessage): FleetMessage => ({
    key: context.vehicleId,
    value: JSON.stringify(value),
    headers: withCorrelationId(undefined, context.correlationId),
  });

  return {
    // `async`: un correlationId inválido (CorrelationIdError) también llega como rechazo, no como lanzamiento síncrono.
    publishAccepted: async (context, events) =>
      publish(
        "telemetry.raw",
        topics.raw,
        events.map((event) => toMessage(context, event)),
      ),
    publishRejected: async (context, messages) =>
      publish(
        "telemetry.dlq",
        topics.dlq,
        messages.map((message) => toMessage(context, message)),
      ),
  };
}

/**
 * Rechaza con `PublishTimeoutError` si `work` no termina a tiempo. El temporizador se cancela siempre. `work` recibe
 * `isAbandoned`: tras el vencimiento devuelve `true` y debe dejar de iniciar trabajo nuevo.
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
