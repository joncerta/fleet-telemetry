import { databaseAdminConfig, databaseConfig } from "@fleet/platform";
import { z } from "zod";

/**
 * Variables de los comandos de desarrollo. Ninguna es obligatoria por sí sola: hace falta al menos una de las dos
 * (ver `resolveDatabaseUrl`).
 */
export const devDataConfigSchema = z.object({
  ...databaseConfig.partial().shape,
  ...databaseAdminConfig.pick({ DATABASE_ADMIN_URL: true }).partial().shape,
});
export type DevDataConfig = z.output<typeof devDataConfigSchema>;

export interface ResolvedDatabase {
  url: string;
  /** Nombre de la variable de la que salió: sirve para el mensaje y nunca se imprime su valor. */
  variable: "DATABASE_URL" | "DATABASE_ADMIN_URL";
}

/**
 * Elige la conexión de menor privilegio que alcance: `DATABASE_URL` (rol `fleet_app`, solo DML) antes que
 * `DATABASE_ADMIN_URL` (superusuario). Sembrar y emitir tokens son INSERT y UPDATE sobre tablas que ya existen,
 * justo lo que `fleet_app` puede hacer; `fleet_ro` no alcanza porque solo lee. El superusuario es el último recurso,
 * para un entorno que aún no tiene la URL de los servicios.
 */
export function resolveDatabaseUrl(config: DevDataConfig): ResolvedDatabase {
  if (config.DATABASE_URL !== undefined) return { url: config.DATABASE_URL, variable: "DATABASE_URL" };
  if (config.DATABASE_ADMIN_URL !== undefined) return { url: config.DATABASE_ADMIN_URL, variable: "DATABASE_ADMIN_URL" };
  throw new Error("Falta la conexión a la base: define DATABASE_URL (preferida, rol fleet_app) o DATABASE_ADMIN_URL.");
}
