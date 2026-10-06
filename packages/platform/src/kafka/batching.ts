import type { FleetMessage } from "./producer.js";

/**
 * Tope de bytes de un `sendBatch`. El broker rechaza un record batch mayor que `max.message.bytes` / `kafka_batch_max_bytes`
 * (1 MiB por defecto en Redpanda y 1 MB en MSK) con `MESSAGE_TOO_LARGE`, que kafkajs no reintenta: la mitad deja margen para el
 * encabezado del batch y los headers. Todo publicador que mande un número de mensajes no acotado por su tamaño debe partir con
 * `splitBySize`.
 */
export const DEFAULT_MAX_BATCH_BYTES = 512 * 1024;

/** Bytes que se suman por mensaje además de su valor: key, headers y encabezado del record. Estimación por lo alto. */
export const MESSAGE_OVERHEAD_BYTES = 256;

const sizeOf = (message: FleetMessage): number => Buffer.byteLength(String(message.value)) + MESSAGE_OVERHEAD_BYTES;

/**
 * Parte los mensajes en grupos consecutivos (se conserva el orden) de a lo sumo `maxBytes`, contando el valor más
 * `MESSAGE_OVERHEAD_BYTES` por mensaje. Un mensaje que por sí solo supera el tope va en su propio grupo.
 */
export function splitBySize(messages: readonly FleetMessage[], maxBytes: number = DEFAULT_MAX_BATCH_BYTES): FleetMessage[][] {
  const groups: FleetMessage[][] = [];
  let current: FleetMessage[] = [];
  let currentBytes = 0;
  for (const message of messages) {
    const bytes = sizeOf(message);
    if (current.length > 0 && currentBytes + bytes > maxBytes) {
      groups.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(message);
    currentBytes += bytes;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}
