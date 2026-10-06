/**
 * Puerto de almacenamiento de la cola. El núcleo (outbox, sync) solo conoce esta interfaz; la implementa el adaptador de
 * expo-sqlite (`infra/sqlite-store.ts`) y, en las pruebas, `core/memory-store.ts`.
 *
 * Contrato: CADA método es atómico (una transacción). En particular `claim`: pasar puntos de `pending` a `in_flight` se
 * reclama en la base, no con un mutex en memoria, porque la tarea en segundo plano puede correr sin la UI.
 */

export interface OutboxEntry {
  readonly eventId: string;
  /** JSON del `TelemetryPoint`, tal como se validó al capturarlo. */
  readonly payload: string;
  readonly createdAt: number;
  readonly attempts: number;
}

export interface NewOutboxEntry {
  readonly eventId: string;
  readonly payload: string;
  readonly createdAt: number;
}

export interface RejectedInput {
  readonly eventId: string;
  readonly reason: string;
}

export interface QueueCounts {
  readonly pending: number;
  readonly inFlight: number;
  /** Rechazos permanentes del servidor, acumulados (tabla `rejected`). */
  readonly rejected: number;
  /** Lotes que el servidor devolvió como `400` (tabla `dead`). */
  readonly dead: number;
  /** Puntos aceptados por el servidor y borrados de la cola (acumulado). */
  readonly sent: number;
  /** Puntos descartados por el tope de la cola (acumulado). */
  readonly discarded: number;
  /** Puntos que no pasaron `telemetryPointSchema` al capturarlos (acumulado). No se encolan. */
  readonly invalidLocal: number;
}

export interface SettleInput {
  /** Los `eventId` del lote reclamado. Solo estos se tocan. */
  readonly batch: readonly string[];
  readonly accepted: readonly string[];
  readonly rejected: readonly RejectedInput[];
  readonly nowMs: number;
}

export interface SettleResult {
  readonly sent: number;
  readonly rejected: number;
  /** Del lote, los que no vinieron ni en `accepted` ni en `rejected`: vuelven a `pending`. */
  readonly released: number;
}

export type MetaKey =
  | "lastSyncAt"
  | "lastServerTime"
  | "lastAckAcceptedCount"
  | "lastAckRejectedCount"
  | "lastClockSkewMs"
  | "lastError"
  | "lastErrorAt"
  | "nextAttemptAt"
  | "backoffAttempt"
  | "syncPausedReason"
  | "shiftStartedAt"
  | "lastFixAt";

export interface OutboxStore {
  /** INSERT del punto. Si la cola supera `cap`, descarta los `pending` más viejos y suma al contador. Atómico. */
  enqueue(entry: NewOutboxEntry, cap: number): Promise<{ discarded: number }>;
  /** `in_flight` con `claimed_at` más viejo que el lease vuelve a `pending`. Devuelve cuántos. */
  reclaimExpired(nowMs: number, leaseMs: number): Promise<number>;
  /**
   * Reclama hasta `limit` puntos `pending` (o menos si superan `maxBytes`; siempre al menos uno), en orden de captura,
   * y los pasa a `in_flight` con `claimed_at = nowMs`. Dos llamadas concurrentes nunca devuelven el mismo punto.
   */
  claim(limit: number, maxBytes: number, nowMs: number): Promise<OutboxEntry[]>;
  /** Aplica un ACK: borra `accepted`, mueve `rejected` a su tabla, devuelve el resto del lote a `pending`. */
  settle(input: SettleInput): Promise<SettleResult>;
  /** Devuelve el lote a `pending` (sube `attempts`). No borra nada. */
  release(eventIds: readonly string[]): Promise<void>;
  /** `400`: saca el lote de la cola y lo guarda en `dead` con el motivo. */
  markDead(batchId: string, eventIds: readonly string[], reason: string, nowMs: number): Promise<void>;
  countInvalidLocal(): Promise<void>;
  counts(): Promise<QueueCounts>;
  rejectedByReason(): Promise<Record<string, number>>;
  getMeta(key: MetaKey): Promise<string | null>;
  setMeta(key: MetaKey, value: string | null): Promise<void>;
}
