import { assertLocalDatabaseHost, assertLocalEnvironmentMark, ENVIRONMENT_SETTING, MigrationError } from "@fleet/platform";

export interface MarkQueryable {
  query(sql: string, params: unknown[]): Promise<{ rows: { value: string | null }[] }>;
}

/**
 * Los comandos de este paquete crean datos de demo y credenciales: solo corren contra una base local. Reutiliza las
 * dos guardas de `db:rollback` (allowlist de host y marca `fleet.environment=local` del servidor), en el mismo orden:
 * primero el host, sin conectar, y después la marca.
 *
 * Las guardas redactan su mensaje pensando en `db:rollback` y en `DATABASE_ADMIN_URL`; aquí se antepone el comando y
 * la variable reales para que el error no confunda. Los mensajes nombran host y marca, nunca credenciales.
 */
export async function assertLocalDatabase(options: {
  url: string;
  variable: string;
  command: string;
  db: MarkQueryable;
}): Promise<void> {
  const { url, variable, command, db } = options;
  try {
    // La guarda de host valida el valor que se le pase, sea cual sea la variable.
    assertLocalDatabaseHost(url);
    const { rows } = await db.query("SELECT current_setting($1, true) AS value", [ENVIRONMENT_SETTING]);
    assertLocalEnvironmentMark(rows[0]?.value);
  } catch (error) {
    if (error instanceof MigrationError) {
      throw new LocalOnlyError(
        `${command} solo corre contra una base local y rechazó la conexión de ${variable}. ` +
          `Detalle de la guarda (compartida con db:rollback; donde dice DATABASE_ADMIN_URL, léase ${variable}): ${error.message}`,
      );
    }
    throw error;
  }
}

export class LocalOnlyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalOnlyError";
  }
}
