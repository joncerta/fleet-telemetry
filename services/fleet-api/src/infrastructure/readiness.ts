import type { Logger } from "@fleet/platform";
import type { ReadinessCheck } from "../application/ports.js";

/** Lo único que hace falta del pool de `pg`. */
export interface Pingable {
  query(sql: string): Promise<unknown>;
}

export const DEFAULT_CHECK_TIMEOUT_MS = 2_000;

/**
 * Rechaza si `work` no termina en `timeoutMs`. El temporizador se cancela siempre, para no retener el proceso.
 * (El trabajo en sí no se aborta: `SELECT 1` queda acotado por el `statement_timeout` del pool.)
 */
async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`sin respuesta en ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ping a la base: `SELECT 1` por el pool de los servicios (rol `fleet_app`). Devuelve `false` ante cualquier fallo
 * o tiempo agotado; el error va al log, nunca al cliente.
 */
export function createDatabaseCheck(pool: Pingable, logger: Pick<Logger, "warn">, timeoutMs = DEFAULT_CHECK_TIMEOUT_MS): ReadinessCheck {
  return {
    name: "database",
    async check() {
      try {
        await withTimeout(pool.query("SELECT 1"), timeoutMs);
        return true;
      } catch (err) {
        logger.warn({ err }, "El ping a la base falló");
        return false;
      }
    },
  };
}
