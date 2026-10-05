import {
  Partitioners,
  type Message,
  type Producer,
  type ProducerBatch,
  type ProducerConfig,
  type ProducerRecord,
  type RecordMetadata,
} from "kafkajs";
import { CorrelationIdError, getCorrelationId, type CorrelatedHeaders } from "./headers.js";

/** Confirmación de todas las réplicas en sync. En kafkajs `acks` se pasa en cada envío, no al crear el productor. */
export const ACKS_ALL = -1;

/**
 * Particionador explícito. En kafkajs v2 `DefaultPartitioner` es el compatible con Java (murmur2): mismo key,
 * misma partición. Todos los productores del sistema deben usar el mismo, o se rompe el orden por vehículo.
 */
export const FLEET_PARTITIONER = Partitioners.DefaultPartitioner;

/**
 * Todos los eventos del sistema llevan key (= `vehicleId`) y un `correlationId` válido en los headers (regla 16):
 * aquí ambos son obligatorios, en el tipo y en runtime.
 */
export interface FleetMessage extends Omit<Message, "key" | "headers"> {
  key: string;
  headers: CorrelatedHeaders;
}

/** Igual que `ProducerRecord`, sin `acks` (lo fija la fábrica) y con mensajes con key obligatoria. */
export interface FleetSendRecord extends Omit<ProducerRecord, "acks" | "messages"> {
  messages: FleetMessage[];
}

export interface FleetSendBatch extends Omit<ProducerBatch, "acks" | "topicMessages"> {
  topicMessages: { topic: string; messages: FleetMessage[] }[];
}

/** Productor idempotente: el único tipo de productor que expone esta librería. */
export interface FleetProducer {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(record: FleetSendRecord): Promise<RecordMetadata[]>;
  sendBatch(batch: FleetSendBatch): Promise<RecordMetadata[]>;
}

/** Lo que la fábrica necesita de `Kafka`: permite probar la configuración sin red. */
export interface ProducerSource {
  producer(config: ProducerConfig): Pick<Producer, "connect" | "disconnect" | "send" | "sendBatch">;
}

/** Únicas opciones que el llamador puede ajustar; las que dan la garantía de entrega no están. */
export type FleetProducerOptions = Pick<ProducerConfig, "retry" | "metadataMaxAge">;

/**
 * Crea el productor del proceso (uno por proceso, no uno por request).
 *
 * Garantías que fija la fábrica, aunque el llamador no las pida:
 * - `idempotent: true`: los reintentos no duplican mensajes en el broker.
 * - `acks = -1` en cada `send` y `sendBatch` (kafkajs lo exige con `idempotent`). El tipo no deja pasar `acks`
 *   y, si alguien lo cuela en runtime, se sobrescribe.
 * - `maxInFlightRequests: 1`: kafkajs no lo exige, pero con varias peticiones en vuelo un reintento puede
 *   reordenar mensajes de un mismo vehículo (o fallar por número de secuencia fuera de orden).
 * - `allowAutoTopicCreation: false`: los tópicos los crea infra (`redpanda-init` en local, Terraform en AWS).
 * - Particionador explícito (`FLEET_PARTITIONER`).
 * - Todo mensaje debe traer un `correlationId` válido en los headers: si falta o no cumple el formato, el envío
 *   se rechaza con `CorrelationIdError` antes de tocar la red, para que ningún productor rompa la traza.
 *
 * Con `idempotent`, kafkajs exige `retry.retries >= 1` y avisa si se limitan los reintentos.
 */
export function createProducer(kafka: ProducerSource, options: FleetProducerOptions = {}): FleetProducer {
  const producer = kafka.producer({
    ...options,
    idempotent: true,
    maxInFlightRequests: 1,
    allowAutoTopicCreation: false,
    createPartitioner: FLEET_PARTITIONER,
  });

  return {
    connect: () => producer.connect(),
    disconnect: () => producer.disconnect(),
    send: async (record) => {
      assertCorrelated(record.messages);
      return producer.send({ ...record, acks: ACKS_ALL });
    },
    sendBatch: async (batch) => {
      for (const { messages } of batch.topicMessages) assertCorrelated(messages);
      return producer.sendBatch({ ...batch, acks: ACKS_ALL });
    },
  };
}

/** El tipo ya lo exige; esto cubre a quien llegue con datos que no pasaron por el compilador. */
function assertCorrelated(messages: readonly Pick<Message, "headers">[]): void {
  for (const message of messages) {
    if (getCorrelationId(message.headers) === undefined) {
      throw new CorrelationIdError("Todo mensaje debe llevar un header correlationId válido (1-128 caracteres de [A-Za-z0-9._:-]).");
    }
  }
}
