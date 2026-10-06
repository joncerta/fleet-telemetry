export interface BackoffPolicy {
  /** Espera mínima y la del primer intento, en ms. */
  initialMs: number;
  /** Tope de la espera, en ms. */
  maxMs: number;
}

/** Reconexión del stream: de 1 s a 30 s (apps/web/CLAUDE.md). */
export const STREAM_BACKOFF: BackoffPolicy = { initialMs: 1_000, maxMs: 30_000 };

/**
 * Espera antes del intento `attempt` (0 = el primero tras un corte): exponencial con jitter COMPLETO entre `initialMs` y un tope que se
 * duplica por intento (`min(maxMs, initialMs * 2^(attempt + 1))`: intento 0 en [1 s, 2 s], intento 1 en [1 s, 4 s]...). Con el jitter
 * desde el primer intento, las pestañas no reconectan todas a la vez cuando una réplica de fleet-api se reinicia. `random` devuelve [0, 1).
 */
export function backoffDelayMs(attempt: number, random: () => number, policy: BackoffPolicy = STREAM_BACKOFF): number {
  const cap = Math.min(policy.maxMs, policy.initialMs * 2 ** (Math.max(0, attempt) + 1));
  const delay = policy.initialMs + random() * (cap - policy.initialMs);
  return Math.round(Math.min(policy.maxMs, Math.max(policy.initialMs, delay)));
}
