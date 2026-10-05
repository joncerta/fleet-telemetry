import { randomUUID } from "node:crypto";
import { Client } from "pg";

/** Las bases temporales de los tests siempre se llaman así; `drop` se niega a borrar cualquier otra. */
const TEMP_DATABASE_NAME = /^fleet_it_[a-f0-9]{12}$/;

export interface TempDatabase {
  readonly name: string;
  /** URL del superusuario apuntando a la base temporal. */
  readonly adminUrl: string;
  /** URL de la base temporal con las credenciales de otro rol (p. ej. `fleet_ro`). */
  urlFor(user: string, password: string): string;
  /** Borra la base, aunque haya conexiones abiertas. */
  drop(): Promise<void>;
}

/** Reemplaza la base de datos de una URL de conexión, conservando host, puerto y credenciales. */
export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/** Plantillas permitidas: allowlist del identificador que entra en `CREATE DATABASE ... TEMPLATE`. */
const TEMPLATES = ["template0", "template1"] as const;

export interface CreateTempDatabaseOptions {
  /**
   * `template0` (por defecto) da una base realmente vacía, sin extensiones: es el baseline limpio que necesita una
   * prueba de ida y vuelta de migraciones, y no depende de lo que el contenedor haya instalado en `template1` (en la
   * imagen de Timescale, `timescaledb` y `timescaledb_toolkit`). Además, `CREATE DATABASE ... TEMPLATE template1`
   * puede quedarse 5 s bloqueado y fallar con "source database is being accessed by other users" porque Timescale
   * lanza un worker sobre la plantilla (ver docs/adr/003).
   */
  template?: (typeof TEMPLATES)[number];
}

/**
 * Crea `fleet_it_<runId>` desde `DATABASE_ADMIN_URL`, para que ningún test toque la base `fleet`.
 * El nombre sale de un UUID y se valida con un patrón antes de entrar en el SQL: `CREATE DATABASE` no admite
 * parámetros, y este patrón y la lista de plantillas son la allowlist de los identificadores.
 */
export async function createTempDatabase(adminUrl: string, { template = "template0" }: CreateTempDatabaseOptions = {}): Promise<TempDatabase> {
  const name = `fleet_it_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  assertTempName(name);
  if (!TEMPLATES.includes(template)) throw new Error(`Plantilla no permitida: ${String(template)}`);

  await withAdmin(adminUrl, (client) => client.query(`CREATE DATABASE "${name}" TEMPLATE ${template}`));

  const tempAdminUrl = withDatabase(adminUrl, name);
  return {
    name,
    adminUrl: tempAdminUrl,
    urlFor(user, password) {
      const parsed = new URL(tempAdminUrl);
      parsed.username = user;
      parsed.password = password;
      return parsed.toString();
    },
    drop: () => dropTempDatabase(adminUrl, name),
  };
}

export async function dropTempDatabase(adminUrl: string, name: string): Promise<void> {
  assertTempName(name);
  await withAdmin(adminUrl, (client) => client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
}

function assertTempName(name: string): void {
  if (!TEMP_DATABASE_NAME.test(name)) {
    throw new Error(`Nombre de base temporal no permitido: ${name}`);
  }
}

async function withAdmin(adminUrl: string, run: (client: Client) => Promise<unknown>): Promise<void> {
  const client = new Client({ connectionString: adminUrl });
  client.on("error", () => undefined);
  await client.connect();
  try {
    await run(client);
  } finally {
    await client.end();
  }
}
