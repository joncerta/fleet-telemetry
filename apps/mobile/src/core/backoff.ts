import { PARAMS } from "./params";

/**
 * Backoff exponencial con jitter completo.
 *
 * El techo de la ventana crece 2x por intento (`min * 2^(attempt+1)`, con tope en `max`) y el retraso se sortea
 * uniformemente en `[min, techo]`. El jitter es obligatorio: cientos de vehículos que recuperan señal a la vez no
 * pueden golpear la API en el mismo segundo. El piso `min` (1 s) evita un loop apretado.
 *
 * `attempt` empieza en 0 (el primer fallo). `random` es inyectable para las pruebas.
 */
export function backoffDelayMs(
  attempt: number,
  random: () => number = Math.random,
  min: number = PARAMS.backoffMinMs,
  max: number = PARAMS.backoffMaxMs,
): number {
  const exponent = Math.min(Math.max(attempt, 0) + 1, 30);
  const ceiling = Math.min(max, min * 2 ** exponent);
  return Math.floor(min + random() * (ceiling - min));
}

/**
 * Espera tras un 429/503: nunca menos que `Retry-After`. Si además hay backoff, se toma el mayor, para que el jitter
 * disperse a la flota por encima del mínimo que pidió el servidor.
 */
export function delayWithRetryAfter(backoffMs: number, retryAfterMs: number | null): number {
  if (retryAfterMs === null) return backoffMs;
  return Math.max(backoffMs, Math.min(retryAfterMs, PARAMS.retryAfterMaxMs));
}

/**
 * Interpreta `Retry-After`: segundos enteros o fecha HTTP. Devuelve milisegundos o `null` si falta o no se entiende.
 */
export function parseRetryAfter(header: string | null | undefined, nowMs: number): number | null {
  if (header === null || header === undefined) return null;
  const value = header.trim();
  if (value === "") return null;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - nowMs);
}
