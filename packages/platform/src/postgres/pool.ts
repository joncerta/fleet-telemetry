import { Pool } from "pg";
import type { Logger } from "pino";

export interface CreatePoolOptions {
  connectionString: string;
  /** Aparece en `pg_stat_activity`: identifica qué servicio tiene cada conexión. */
  applicationName: string;
  /** Recibe los errores de conexiones inactivas del pool. */
  logger: Pick<Logger, "error">;
  /** Corta consultas largas. Por defecto 15 s; las consultas a hypertables llevan siempre rango de tiempo. */
  statementTimeoutMs?: number;
  /** Corta transacciones abandonadas que retienen locks (un `BEGIN` sin `COMMIT` ni `ROLLBACK`). */
  idleInTransactionTimeoutMs?: number;
  max?: number;
  connectionTimeoutMs?: number;
  idleTimeoutMs?: number;
}

/**
 * Pool de `pg` (uno por proceso). Fija:
 * - `application_name` y `statement_timeout` en cada conexión;
 * - sesión en UTC (`timezone=UTC`), para que `date_trunc` y el texto de los `timestamptz` no dependan del servidor;
 * - el manejador del evento `error`: sin él, un error en una conexión inactiva (reinicio de la base, corte de
 *   red) emite `error` sin listener y tumba el proceso.
 *
 * `pg` devuelve `bigint` y `numeric` como string: se convierten explícitamente donde se leen.
 */
export function createPool(options: CreatePoolOptions): Pool {
  const pool = new Pool({
    connectionString: options.connectionString,
    application_name: options.applicationName,
    statement_timeout: options.statementTimeoutMs ?? 15_000,
    idle_in_transaction_session_timeout: options.idleInTransactionTimeoutMs ?? 30_000,
    options: "-c timezone=UTC",
    max: options.max ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 5_000,
    idleTimeoutMillis: options.idleTimeoutMs ?? 30_000,
  });

  pool.on("error", (err) => {
    // Error de conexión, no de una consulta: no lleva datos de filas. Sin `connectionString` en el log.
    options.logger.error({ err, application: options.applicationName }, "Error en una conexión inactiva del pool de Postgres");
  });

  return pool;
}
