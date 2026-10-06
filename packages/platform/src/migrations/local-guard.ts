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
      `(la base está ${found}). La marca la fija docker-compose.yml en el servidor local: ` +
      "si el contenedor es anterior a la marca, recrea el contenedor con `docker compose up -d --wait` (sin `-v`: el volumen y los datos se conservan). " +
      "Un down puede destruir datos: en cualquier otro entorno se escribe una migración nueva que corrija el esquema.",
  );
}

/**
 * Parámetros de la URL con los que `pg` conectaría a un host distinto del que se ve en el authority.
 * (`options` tiene su propia guarda, `assertNoConnectionOptions`: no cambia el host, pero sí la sesión.)
 */
const HOST_OVERRIDE_PARAMS = ["host", "hostaddr", "service"] as const;

/**
 * Parámetros de la query tal como los lee `pg`: `pg-connection-string` hace `new URL(str, "postgres://base")` (con
 * los espacios codificados y un host de relleno si la URL no tiene host) y copia **cada** parámetro a la configuración
 * de la conexión, donde pisa lo que el código pasó de forma explícita. Si la URL no se puede leer, `pg` fallará igual.
 */
function connectionParams(adminUrl: string): URLSearchParams {
  if (adminUrl.startsWith("/")) return new URLSearchParams();
  const text = /( |%[^a-f0-9]|%[a-f0-9][^a-f0-9])/i.test(adminUrl) ? encodeURI(adminUrl).replaceAll(/%25(\d\d)/g, "%$1") : adminUrl;
  for (const candidate of [text, text.replace("@/", "@___DUMMY___/")]) {
    try {
      return new URL(candidate, "postgres://base").searchParams;
    } catch {
      // se prueba la siguiente forma, como hace `pg`
    }
  }
  return new URLSearchParams();
}

/**
 * Falla si `DATABASE_ADMIN_URL` trae `?options=`. `pg` copia ese parámetro a la configuración y **pisa** el `options`
 * de la sesión de migración, con dos efectos: (1) reemplaza en silencio `lock_timeout`,
 * `idle_in_transaction_session_timeout`, `timezone` y `default_transaction_read_only` (`status` y `--dry-run` dejarían de
 * ser de solo lectura); (2) `-c fleet.environment=local` daría la marca local a una base remota a la que llega un túnel,
 * y la segunda guarda de `db:rollback` quedaría anulada. El mensaje no cita el valor ni las credenciales.
 */
export function assertNoConnectionOptions(adminUrl: string): void {
  if (!connectionParams(adminUrl).has("options")) return;
  throw new MigrationError(
    'DATABASE_ADMIN_URL usa el parámetro "options": la sesión de migración fija sus propios parámetros (timezone, lock_timeout, ' +
      "idle_in_transaction_session_timeout y default_transaction_read_only) y un ?options= de la URL los reemplazaría en silencio. " +
      "Quítalo de la URL.",
  );
}

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

  assertNoConnectionOptions(adminUrl);

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
