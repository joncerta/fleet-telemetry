import { MAX_BATCH_POINTS } from "@fleet/contracts";

/** Parámetros de `apps/mobile/CLAUDE.md`. No inventar otros. */
export const PARAMS = {
  /**
   * Captura: latido cada 5 s con `distanceInterval = 0`, también con el vehículo detenido: el processor calcula la
   * detención (`stoppedSince`) y `critical_zone_stop` con los puntos que llegan durante una parada.
   * Mejora futura: intervalo adaptativo para ahorrar batería.
   */
  captureTimeIntervalMs: 5_000,
  captureDistanceIntervalM: 0,
  /** Precisión mínima: peor que esto se guarda marcado `lowAccuracy`, no se descarta. */
  minAccuracyM: 50,
  /** Lote: 200 puntos o el máximo del contrato, lo que sea menor. */
  maxBatchPoints: Math.min(200, MAX_BATCH_POINTS),
  /** Tope en bytes del cuerpo de un lote (el gateway acepta 1 MiB por defecto). */
  maxBatchBytes: 512 * 1024,
  /** Backoff exponencial con jitter completo, de 1 s a 60 s. */
  backoffMinMs: 1_000,
  backoffMaxMs: 60_000,
  /** Un `Retry-After` mayor que esto se recorta (protege contra un valor absurdo). */
  retryAfterMaxMs: 15 * 60_000,
  /** Lease de `in_flight`: pasado este tiempo, el punto vuelve a `pending`. */
  leaseMs: 60_000,
  /** Timeout de un request de envío. Menor que el lease, para soltar el lote antes de que venza. */
  requestTimeoutMs: 20_000,
  /** Tope de la cola: al llegar, se descartan los más viejos y se cuentan. */
  queueCap: 50_000,
  /** Pausa por 401/403: cada cuánto se manda UN lote de prueba para detectar que el token volvió a ser válido. */
  unauthorizedProbeMs: 5 * 60_000,
  /** Reintento periódico mientras haya pendientes y red. */
  periodicSyncMs: 15_000,
} as const;
