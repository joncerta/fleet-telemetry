export interface BackoffPolicy {
  /** Espera mínima y la del primer intento, en ms. */
  initialMs: number;
  /** Tope de la espera, en ms. */
  maxMs: number;
}

/** Reconexión del stream: de 1 s a 30 s (apps/web/CLAUDE.md). */
export const STREAM_BACKOFF: BackoffPolicy = { initialMs: 1_000, maxMs: 30_000 };

/**
 * Espera antes del intento `attempt` (0 = el primero tras un corte): exponencial con jitter "igual" (entre la mitad y el total del
 * tope del intento) y nunca menos que `initialMs`. El jitter reparte en el tiempo las reconexiones de cientos de pestañas cuando
 * fleet-api vuelve, en vez de que todas golpeen a la vez. `random` devuelve [0, 1).
 */
export function backoffDelayMs(attempt: number, random: () => number, policy: BackoffPolicy = STREAM_BACKOFF): number {
  const cap = Math.min(policy.maxMs, policy.initialMs * 2 ** Math.max(0, attempt));
  const delay = cap / 2 + random() * (cap / 2);
  return Math.round(Math.min(policy.maxMs, Math.max(policy.initialMs, delay)));
}
