import { assertLocalDatabase, issueDeviceToken, type SeedVehicle } from "@fleet/dev-data";
import type { Pool } from "pg";

export interface AcquireTokensInput {
  /** Un `Pool` de `pg`: `connect` para emitir en transacción y `query` para leer la marca del servidor. */
  pool: Pick<Pool, "connect"> & { query(sql: string, params: unknown[]): Promise<{ rows: { value: string | null }[] }> };
  /** URL con la que se conectó el pool y nombre de su variable: la guarda valida el host y los mensajes nombran la variable. */
  databaseUrl: string;
  variable: "DATABASE_URL" | "DATABASE_ADMIN_URL";
  vehicles: readonly SeedVehicle[];
}

/**
 * Token de dispositivo de cada vehículo, por `vehicleId`. Reutiliza `issueDeviceToken` de `@fleet/dev-data` (mismo formato y mismo
 * hash, sin duplicarlos) y, antes de tocar nada, las guardas de base local: host de la allowlist y marca `fleet.environment=local`.
 *
 * Emitir ROTA: revoca el dispositivo activo del vehículo, así que un token que alguien emitió con `pnpm device:token` para esos
 * vehículos deja de valer. Los tokens quedan solo en el mapa devuelto (memoria): ni se loguean ni se escriben a disco.
 */
export async function acquireDeviceTokens(input: AcquireTokensInput): Promise<ReadonlyMap<string, string>> {
  await assertLocalDatabase({ url: input.databaseUrl, variable: input.variable, command: "simulate", db: input.pool });
  const tokens = new Map<string, string>();
  for (const vehicle of input.vehicles) {
    const issued = await issueDeviceToken(input.pool, vehicle.id);
    tokens.set(vehicle.id, issued.token);
  }
  return tokens;
}
