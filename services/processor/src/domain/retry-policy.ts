/** Backoff exponencial entre reintentos (factor 2) con tope. */
export interface BackoffPolicy {
  /** Espera de referencia antes del primer reintento, en ms. */
  readonly initialDelayMs: number;
  /** Tope de la espera, en ms. */
  readonly maxDelayMs: number;
}

/**
 * Espera antes del reintento número `retryNumber` (1 = el primero): `min(maxDelayMs, initialDelayMs * 2^(n-1))` con
 * jitter "equal": una espera uniforme entre la mitad del techo y el techo. Garantiza que las réplicas que fallaron a la
 * vez no reintenten en bloque y, a diferencia del jitter completo, nunca espera casi cero.
 *
 * `random` es un número en `[0, 1)` y entra como argumento: el dominio no genera aleatoriedad.
 */
export function backoffDelayMs(retryNumber: number, policy: BackoffPolicy, random: number): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** (retryNumber - 1));
  return Math.round(ceiling / 2 + (ceiling / 2) * random);
}
