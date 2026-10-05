import type { Admin, AdminConfig, Consumer, ConsumerConfig } from "kafkajs";

export interface AdminSource {
  admin(config?: AdminConfig): Admin;
}

export interface ConsumerSource {
  consumer(config: ConsumerConfig): Consumer;
}

/** Cliente admin. Solo para tareas de infraestructura y tests: los servicios no crean ni borran tópicos. */
export function createAdmin(kafka: AdminSource): Admin {
  return kafka.admin({ retry: { retries: 5 } });
}

export interface FleetConsumerOptions
  extends Pick<
    ConsumerConfig,
    | "sessionTimeout"
    | "rebalanceTimeout"
    | "heartbeatInterval"
    | "maxBytesPerPartition"
    | "maxWaitTimeInMs"
    | "retry"
    | "metadataMaxAge"
  > {
  /**
   * Obligatorio y sin valor por defecto: el consumer group es una decisión de cada servicio. El processor
   * comparte group entre réplicas; fleet-api necesita uno por réplica (regla 6 de CLAUDE.md).
   */
  groupId: string;
}

/**
 * Consumer con valores por defecto explícitos. Lo único que cambia respecto de los de kafkajs es
 * `allowAutoTopicCreation: false` (kafkajs lo activa por defecto); el resto fija los valores actuales para que
 * una actualización de la librería no cambie el comportamiento sin que se note.
 *
 * Este helper no decide el commit de offsets: `autoCommit` y el commit después de persistir se definen en
 * `consumer.run` de cada servicio (fase 1a).
 */
export function createConsumer(kafka: ConsumerSource, options: FleetConsumerOptions): Consumer {
  return kafka.consumer({
    sessionTimeout: 30_000,
    rebalanceTimeout: 60_000,
    heartbeatInterval: 3_000,
    maxWaitTimeInMs: 5_000,
    ...options,
    allowAutoTopicCreation: false,
    readUncommitted: false,
  });
}
