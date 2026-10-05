import { MigrationError } from "./files.js";

/**
 * Hosts donde `db:rollback` puede correr: la máquina local y el servicio `timescaledb` de la red de compose.
 * Es una allowlist fija; no se amplía por configuración. Un down destruye datos y solo es legítimo en local.
 */
export const LOCAL_DATABASE_HOSTS: readonly string[] = ["127.0.0.1", "localhost", "::1", "timescaledb"];

/**
 * Marca del servidor que declara una base como local (`-c fleet.environment=local` en `docker-compose.yml`, también en CI).
 * Segunda guarda de `db:rollback`, además de la allowlist de host: un túnel o un `/etc/hosts` pueden hacer que
 * `localhost` apunte a una base remota, pero no pueden darle esa marca.
 */
export const ENVIRONMENT_SETTING = "fleet.environment";
export const LOCAL_ENVIRONMENT = "local";

/**
 * Decide con el valor de `current_setting('fleet.environment', true)`: solo `local` pasa; ausente (`null`), vacío o
 * cualquier otro valor se rechaza. El mensaje explica que la base no está marcada como local, sin credenciales.
 */
export function assertLocalEnvironmentMark(value: string | null | undefined): void {
  if (value === LOCAL_ENVIRONMENT) return;
  const found = value === null || value === undefined || value === "" ? "sin marca" : `marcada como "${value}"`;
  throw new MigrationError(
    `db:rollback solo corre contra una base marcada como local: el servidor debe tener ${ENVIRONMENT_SETTING}=${LOCAL_ENVIRONMENT} ` +
      `(la base está ${found}). La marca la fija docker-compose.yml en el servidor local; ` +
      "un down puede destruir datos: en cualquier otro entorno se escribe una migración nueva que corrija el esquema.",
  );
}

/** Parámetros de la URL con los que `pg` conectaría a un host distinto del que se ve en el authority. */
const HOST_OVERRIDE_PARAMS = ["host", "hostaddr", "service"] as const;

/**
 * Falla si `DATABASE_ADMIN_URL` no apunta a un host local. Mira el host real con el que conectaría `pg`: un
 * `?host=...` en la query lo sustituiría, así que también se rechaza. El mensaje nombra el host, nunca las credenciales.
 */
export function assertLocalDatabaseHost(adminUrl: string): void {
  let url: URL;
  try {
    url = new URL(adminUrl);
  } catch {
    throw new MigrationError("DATABASE_ADMIN_URL no es una URL válida: db:rollback solo corre contra una base local.");
  }

  const override = HOST_OVERRIDE_PARAMS.find((param) => url.searchParams.has(param));
  if (override) {
    throw new MigrationError(
      `DATABASE_ADMIN_URL usa el parámetro "${override}": db:rollback solo acepta el host del authority de la URL, y solo si es local.`,
    );
  }

  // `URL.hostname` devuelve las direcciones IPv6 entre corchetes.
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!LOCAL_DATABASE_HOSTS.includes(host)) {
    throw new MigrationError(
      `db:rollback solo corre contra una base local (${LOCAL_DATABASE_HOSTS.join(", ")}); DATABASE_ADMIN_URL apunta a "${host}". ` +
        "Un down puede destruir datos: en cualquier otro entorno se escribe una migración nueva que corrija el esquema.",
    );
  }
}
