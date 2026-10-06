import type { OutboxStore, QueueCounts } from "./store";

export interface Diagnostics {
  readonly counts: QueueCounts;
  readonly rejectedByReason: Record<string, number>;
  readonly lastSyncAt: string | null;
  /** Hora del servidor en el último ACK. */
  readonly lastServerTime: string | null;
  readonly lastAckAccepted: number | null;
  readonly lastAckRejected: number | null;
  readonly clockSkewMs: number | null;
  readonly lastError: string | null;
  readonly lastErrorAt: string | null;
  readonly nextAttemptAt: number | null;
  /** `unauthorized` (401/403, con lote de prueba periódico) o `client_error` (400): el sync está detenido. "Sin vincular" no se persiste: se deduce de las credenciales. */
  readonly pausedReason: string | null;
  readonly shiftStartedAt: number | null;
  readonly lastFixAt: number | null;
}

const num = (v: string | null): number | null => (v === null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));

/** Lectura de solo lectura para la pantalla de diagnóstico y el indicador siempre visible. Sin coordenadas. */
export async function readDiagnostics(store: OutboxStore): Promise<Diagnostics> {
  const [counts, rejectedByReason, lastSyncAt, lastServerTime, accepted, rejected, skew, lastError, lastErrorAt, nextAt, paused, shift, fix] =
    await Promise.all([
      store.counts(),
      store.rejectedByReason(),
      store.getMeta("lastSyncAt"),
      store.getMeta("lastServerTime"),
      store.getMeta("lastAckAcceptedCount"),
      store.getMeta("lastAckRejectedCount"),
      store.getMeta("lastClockSkewMs"),
      store.getMeta("lastError"),
      store.getMeta("lastErrorAt"),
      store.getMeta("nextAttemptAt"),
      store.getMeta("syncPausedReason"),
      store.getMeta("shiftStartedAt"),
      store.getMeta("lastFixAt"),
    ]);
  return {
    counts,
    rejectedByReason,
    lastSyncAt,
    lastServerTime,
    lastAckAccepted: num(accepted),
    lastAckRejected: num(rejected),
    clockSkewMs: num(skew),
    lastError,
    lastErrorAt,
    nextAttemptAt: num(nextAt),
    pausedReason: paused,
    shiftStartedAt: num(shift),
    lastFixAt: num(fix),
  };
}

/** Estado de la red para el conductor, a partir de netinfo. `isInternetReachable` puede venir `null` al inicio. */
export type ConnectionState = "online" | "offline" | "unknown";

export function connectionStateOf(net: { isConnected: boolean | null; isInternetReachable: boolean | null }): ConnectionState {
  if (net.isConnected === false || net.isInternetReachable === false) return "offline";
  if (net.isInternetReachable === true) return "online";
  return "unknown";
}

/** Estado de sync legible para el indicador del conductor. */
export type SyncSummary = "synced" | "pending" | "backoff" | "paused" | "idle";

export function syncSummaryOf(d: Pick<Diagnostics, "counts" | "pausedReason" | "nextAttemptAt">, nowMs: number): SyncSummary {
  if (d.pausedReason !== null) return "paused";
  if (d.counts.pending + d.counts.inFlight === 0) return d.counts.sent > 0 ? "synced" : "idle";
  if (d.nextAttemptAt !== null && d.nextAttemptAt > nowMs) return "backoff";
  return "pending";
}
