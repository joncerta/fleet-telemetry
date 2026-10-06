import { resolveCorrelationId } from "@fleet/platform";
import type { IHeaders, Offsets } from "kafkajs";
import type { PersistTelemetryBatch } from "../../application/persist-telemetry-batch.js";

/**
 * Lo único que el handler usa del payload de `eachBatch` de kafkajs: el real lo cumple, y los tests lo implementan sin
 * casts.
 */
export interface TelemetryBatchPayload {
  batch: {
    topic: string;
    partition: number;
    messages: readonly { offset: string; key: Buffer | null; value: Buffer | null; headers?: IHeaders | undefined }[];
  };
  // Propiedades de función (no métodos): kafkajs las entrega como cierres sueltos y se usan desestructuradas.
  resolveOffset: (offset: string) => void;
  heartbeat: () => Promise<void>;
  /** Con `offsets` confirma ESOS offsets ya; sin argumentos solo confirma si se cumple un umbral, y aquí no hay ninguno. */
  commitOffsetsIfNecessary: (offsets?: Offsets) => Promise<void>;
  isRunning: () => boolean;
  isStale: () => boolean;
}

export type BatchHandler = (payload: TelemetryBatchPayload) => Promise<void>;

/** Siguiente offset a leer tras `offset` (los offsets de Kafka son enteros de 64 bits: se suman como `bigint`). */
const nextOffset = (offset: string): string => (BigInt(offset) + 1n).toString();

/**
 * Handler de `eachBatch` para `telemetry.raw`. Solo traduce y delega (regla 2 de CLAUDE.md): decodifica key y valor como
 * UTF-8, lee el `correlationId` del header de cada mensaje (si falta o es inválido, uno nuevo, para no perder la traza
 * desde aquí) y conecta `resolveOffset`, `heartbeat` y `commitOffsetsIfNecessary` del consumer con el caso de uso.
 * Parseo, persistencia, reintentos y DLQ son del caso de uso. Si este lanza, el error sube a kafkajs, que no confirma lo
 * que no se resolvió y reentrega el lote.
 *
 * `commit(offset)` confirma de verdad, tramo a tramo: llama a `commitOffsetsIfNecessary` con los offsets EXPLÍCITOS de la
 * partición. En kafkajs 2.2.4, con argumento hace `commitOffsets(offsets)` directo; sin él solo confirma si se cumple un
 * umbral (`autoCommitThreshold` o `autoCommitInterval`) y aquí no hay ninguno, así que no haría nada. El offset que se
 * confirma es el SIGUIENTE a leer (`offset + 1`), como exige el protocolo de Kafka.
 */
export function createTelemetryBatchHandler(persist: PersistTelemetryBatch): BatchHandler {
  return async ({ batch, resolveOffset, heartbeat, commitOffsetsIfNecessary, isRunning, isStale }) => {
    const { topic, partition } = batch;
    await persist({
      partition,
      messages: batch.messages.map((message) => ({
        offset: message.offset,
        key: message.key?.toString("utf8") ?? null,
        value: message.value?.toString("utf8") ?? null,
        correlationId: resolveCorrelationId(message.headers),
      })),
      checkpoint: {
        resolve: (offset) => resolveOffset(offset),
        heartbeat: () => heartbeat(),
        commit: (offset) => commitOffsetsIfNecessary({ topics: [{ topic, partitions: [{ partition, offset: nextOffset(offset) }] }] }),
        shouldContinue: () => isRunning() && !isStale(),
      },
    });
  };
}
