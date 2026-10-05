/** SQLSTATE de un error de `pg`, o `undefined` si no es un error de Postgres. */
export function sqlState(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

/** `lock_not_available`: se agotó `lock_timeout` esperando un lock de tabla, fila u objeto. */
export const LOCK_NOT_AVAILABLE = "55P03";
/** `idle_in_transaction_session_timeout`: la sesión se quedó inactiva dentro de una transacción. */
export const IDLE_IN_TRANSACTION_TIMEOUT = "25P03";

/**
 * Qué hacer cuando una migración choca con la carga de la base. `undefined` si el error no es un timeout de la
 * sesión de migración. Los valores salen de la configuración, nunca del error de `pg`.
 */
export function timeoutHint(error: unknown, timeouts: { lockTimeoutMs: number; idleInTransactionTimeoutMs: number }): string | undefined {
  switch (sqlState(error)) {
    case LOCK_NOT_AVAILABLE:
      return (
        `No se obtuvo un lock de la base en ${timeouts.lockTimeoutMs} ms: otra sesión está usando esos objetos. ` +
        "Reintenta en una ventana de menos carga."
      );
    case IDLE_IN_TRANSACTION_TIMEOUT:
      return (
        `La sesión de migración estuvo inactiva más de ${timeouts.idleInTransactionTimeoutMs} ms dentro de una transacción ` +
        "y Postgres la cerró. Reintenta en una ventana de menos carga."
      );
    default:
      return undefined;
  }
}
