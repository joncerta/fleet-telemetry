import { assertLocalDatabaseHost } from "@fleet/platform";
import { assertLocalDatabase, type MarkQueryable } from "../local-only.js";

/** Lo único que hace falta de un cliente conectado al servidor: consultar la marca `fleet.environment` y cerrarse. */
export interface EvidenceConnection extends MarkQueryable {
  end(): Promise<void>;
}

/**
 * `db:evidence` crea una base temporal con millones de filas: solo corre contra un servidor local. Aplica las dos guardas de
 * `db:rollback`, en orden: el host de `DATABASE_ADMIN_URL` ANTES de conectar (un host remoto no recibe ni la conexión) y, ya
 * conectado, la marca `fleet.environment=local` del servidor. Si la marca falla, cierra la conexión y relanza.
 */
export async function connectLocalAdmin(adminUrl: string, connect: (url: string) => Promise<EvidenceConnection>): Promise<EvidenceConnection> {
  assertLocalDatabaseHost(adminUrl);
  const connection = await connect(adminUrl);
  try {
    await assertLocalDatabase({ url: adminUrl, variable: "DATABASE_ADMIN_URL", command: "db:evidence", db: connection });
  } catch (error) {
    await connection.end();
    throw error;
  }
  return connection;
}
