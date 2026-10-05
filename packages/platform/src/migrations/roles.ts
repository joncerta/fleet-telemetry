import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { MigrationError } from "./files.js";
import { LOCK_NOT_AVAILABLE, sqlState } from "./sql-errors.js";

/** Lo mínimo que se necesita de un cliente `pg`; permite probar el manejo de errores sin base de datos. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * Allowlist de roles. `ALTER ROLE` no acepta parámetros y el nombre del rol es un identificador: solo estos dos
 * nombres, fijos en el código, llegan al `format('%I')`; nunca un valor de fuera.
 */
export const FLEET_ROLES = ["fleet_app", "fleet_ro"] as const;
export type FleetRole = (typeof FLEET_ROLES)[number];
export type RolePasswords = Readonly<Record<FleetRole, string>>;

const MAX_ATTEMPTS = 5;

/** Iteraciones de PBKDF2 por defecto de Postgres (`scram_iterations`). */
const SCRAM_ITERATIONS = 4096;
const SCRAM_SALT_BYTES = 16;

export interface ScramOptions {
  /** Solo para pruebas con un vector conocido; por defecto, 16 bytes aleatorios. */
  readonly salt?: Buffer;
  readonly iterations?: number;
}

/**
 * Verificador SCRAM-SHA-256 calculado en el cliente, con el formato que guarda `pg_authid` y que genera el
 * `\password` de psql: `SCRAM-SHA-256$<iteraciones>:<salt>$<StoredKey>:<ServerKey>` (RFC 5802 y 7677; sal y claves
 * en base64). Postgres acepta un verificador ya calculado en `PASSWORD '...'` y no lo vuelve a procesar.
 *
 * Solo admite contraseñas ASCII imprimibles: SASLprep (RFC 4013) normalizaría otras de forma distinta a la del
 * servidor y la contraseña real no autenticaría. En ASCII imprimible SASLprep es la identidad.
 */
export function scramSha256Verifier(password: string, options: ScramOptions = {}): string {
  if (!/^[ -~]+$/.test(password)) {
    throw new MigrationError("La contraseña de un rol solo puede tener caracteres ASCII imprimibles y no puede estar vacía.");
  }
  const salt = options.salt ?? randomBytes(SCRAM_SALT_BYTES);
  const iterations = options.iterations ?? SCRAM_ITERATIONS;

  const saltedPassword = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", saltedPassword).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", saltedPassword).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

/**
 * Da `LOGIN` y contraseña a `fleet_app` y `fleet_ro` (la migración 001 los crea `NOLOGIN`).
 *
 * Regla 12 (SQL parametrizado, sin concatenar): `ALTER ROLE` no admite `$1`, así que la sentencia se arma
 * **en el servidor** con `format('ALTER ROLE %I WITH LOGIN PASSWORD %L', $1, $2)`. `%I` cita el identificador y
 * `%L` el literal, con el rol y el verificador como parámetros; el cliente nunca concatena SQL. Se ejecuta el
 * texto que devuelve el servidor.
 *
 * La contraseña en claro no viaja al servidor: se envía el verificador SCRAM-SHA-256 (`scramSha256Verifier`). Con
 * `log_min_error_statement = error` (el valor por defecto) una sentencia fallida, y los reintentos de `alterRole`
 * lo son, queda en el log de Postgres; con el verificador ahí no hay contraseña utilizable (sigue siendo material
 * sensible: permite un ataque de fuerza bruta fuera de línea, así que el log del servidor debe tratarse como tal).
 *
 * Los errores no llevan la contraseña ni la causa original: los errores de `pg` pueden citar fragmentos de la
 * sentencia, así que se descartan y solo se conserva el código SQLSTATE.
 */
export async function setRolePasswords(db: Queryable, passwords: RolePasswords): Promise<void> {
  for (const role of FLEET_ROLES) {
    await alterRole(db, role, passwords[role]);
  }
}

async function alterRole(db: Queryable, role: FleetRole, password: string): Promise<void> {
  // Una vez por rol, fuera del bucle: los reintentos reutilizan el mismo verificador. Si la contraseña no es
  // válida, el error (de MigrationError) no la incluye.
  const verifier = scramSha256Verifier(password);
  for (let attempt = 1; ; attempt++) {
    try {
      const { rows } = await db.query("SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', $1::text, $2::text) AS statement", [
        role,
        verifier,
      ]);
      const statement = rows[0]?.statement;
      if (typeof statement !== "string") throw new Error("format() no devolvió una sentencia");
      await db.query(statement);
      return;
    } catch (error) {
      // Los roles son del cluster, no de la base: dos migraciones simultáneas sobre bases distintas pueden
      // pisarse la misma fila de pg_authid. El segundo intento ve el cambio ya confirmado.
      if (attempt < MAX_ATTEMPTS && isConcurrentRoleUpdate(error)) {
        await delay(50 * attempt);
        continue;
      }
      // Sin `cause`: el error original puede contener la sentencia con la contraseña.
      throw new MigrationError(`No se pudo asignar la contraseña del rol ${role} (SQLSTATE ${sqlState(error) ?? "desconocido"}).${sqlState(error) === LOCK_NOT_AVAILABLE ? " Reintenta en una ventana de menos carga." : ""}`);
    }
  }
}

function isConcurrentRoleUpdate(error: unknown): boolean {
  return sqlState(error) === "XX000" && error instanceof Error && error.message.includes("tuple concurrently updated");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
