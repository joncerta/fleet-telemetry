import type { TelemetryDlqMessage, TelemetryRawEvent } from "@fleet/contracts";

/** Puertos del processor: lo que sus casos de uso necesitan del mundo exterior. */

/** Reloj del servidor. Un puerto, para que los casos de uso no dependan de la hora real en los tests. */
export interface Clock {
  now(): Date;
}

/** Espera entre reintentos. Un puerto, para probar el backoff sin esperar de verdad. */
export interface Sleeper {
  sleep(ms: number): Promise<void>;
}

/** Aleatoriedad para el jitter del backoff. */
export interface Randomness {
  /** Un número en `[0, 1)`. */
  next(): number;
}

export interface InsertOutcome {
  /** Filas realmente insertadas. Las que ya existían (mismo `eventId` y `recordedAt`) no cuentan. */
  readonly inserted: number;
}

/** Almacén de la telemetría. */
export interface TelemetryRepository {
  /**
   * Inserta los eventos en UNA sola operación atómica e idempotente: lo que ya existe (mismo `eventId` y `recordedAt`) se
   * ignora, también si se repite dentro de `events`. Si la operación falla, no queda nada insertado. El error de la base
   * se propaga tal cual (el caso de uso lo clasifica).
   */
  insertBatch(events: readonly TelemetryRawEvent[]): Promise<InsertOutcome>;
}

export interface DeadLetterEntry {
  /** Key del mensaje de Kafka: el `vehicleId` si se conoce. */
  readonly key: string;
  readonly correlationId: string;
  readonly message: TelemetryDlqMessage;
}

/** Publica en `telemetry.dlq`. */
export interface DeadLetterPublisher {
  /**
   * Resuelve solo cuando TODOS los mensajes quedaron confirmados por el broker (`acks=-1`) y rechaza si no lo lograron:
   * nunca resuelve a medias.
   */
  publish(entries: readonly DeadLetterEntry[]): Promise<void>;
}

/**
 * El avance dentro de un lote de Kafka de una partición. Es lo único que el caso de uso sabe de los offsets: la entrada
 * lo implementa con las funciones del consumer. Nada se confirma hasta que `resolve` marca el offset, y el caso de uso
 * solo lo llama DESPUÉS de persistir y de que la DLQ de ese tramo esté confirmada (regla 6 de CLAUDE.md).
 */
export interface BatchCheckpoint {
  /** Marca como procesados todos los mensajes de la partición hasta `offset` inclusive. */
  resolve(offset: string): void;
  /** Avisa al broker de que el consumer sigue vivo. Puede rechazar si hay un rebalanceo: el error se propaga. */
  heartbeat(): Promise<void>;
  /**
   * Confirma en el broker, YA (sin esperar umbrales), todo lo procesado de la partición hasta `offset` inclusive. La entrada
   * calcula el siguiente offset a leer y lo pasa explícito: `commitOffsetsIfNecessary()` sin argumentos de kafkajs no confirma
   * nada mientras no se cumpla un umbral, y no hay ninguno configurado.
   */
  commit(offset: string): Promise<void>;
  /** `false` si el consumer se está deteniendo o la partición se reasignó: hay que dejar de procesar, sin error. */
  shouldContinue(): boolean;
}

/** Lo que el caso de uso necesita de un logger estructurado. Nunca recibe coordenadas ni el contenido de un mensaje. */
export interface ProcessorLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}
