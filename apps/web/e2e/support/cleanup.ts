import { assertLocalDatabase } from "@fleet/dev-data";
import pg from "pg";
import type { E2eEnv } from "./env";

/** Las placas que crea el e2e: `E2E` + 8 hex en mayúsculas. Nada más se borra jamás, aunque alguien pase otra placa. */
export const E2E_PLATE_PATTERN = /^E2E[0-9A-F]{8}$/;

/** Los nombres de zona que crea el e2e: `E2E Zona ` + 8 hex en minúsculas. Nada más se borra jamás. */
export const E2E_ZONE_NAME_PATTERN = /^E2E Zona [0-9a-f]{8}$/;

/** Nombre de zona único por corrida (el e2e se repite sobre una base con historial y el nombre es único por flota). */
export const uniqueE2eZoneName = (hex: string): string => `E2E Zona ${hex.toLowerCase()}`;

/** Borra las zonas creadas por un test (por nombre). Solo la base local y solo nombres con la forma `E2E Zona …`; SQL parametrizado. */
export async function deleteE2eZones(env: E2eEnv, names: readonly string[]): Promise<void> {
  const safe = names.filter((name) => E2E_ZONE_NAME_PATTERN.test(name));
  if (safe.length === 0) return;
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 1 });
  try {
    await assertLocalDatabase({ url: env.DATABASE_URL, variable: "DATABASE_URL", command: "test:e2e (web)", db: pool });
    await pool.query("DELETE FROM zones WHERE name = ANY($1::text[])", [safe]);
  } finally {
    await pool.end();
  }
}

/** Placa única por corrida (alfanumérica, sin guion): el e2e se repite sobre una base con historial. */
export const uniqueE2ePlate = (hex: string): string => `E2E${hex.toUpperCase()}`;

/**
 * Borra los vehículos creados por un test (por placa) con lo que cuelga de ellos: códigos de vinculación y dispositivos. SQL
 * parametrizado, en una transacción, solo contra la base local (guarda de `@fleet/dev-data`) y solo placas con la forma `E2E…`.
 * Sin esto cada corrida deja vehículos sin señal en Norte, sube el KPI "Sin señal" y acaba sacando vehículos reales del tope del catálogo.
 */
export async function deleteE2eVehicles(env: E2eEnv, plates: readonly string[]): Promise<void> {
  const safe = plates.filter((plate) => E2E_PLATE_PATTERN.test(plate));
  if (safe.length === 0) return;
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 1 });
  try {
    await assertLocalDatabase({ url: env.DATABASE_URL, variable: "DATABASE_URL", command: "test:e2e (web)", db: pool });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const ids = "SELECT id FROM vehicles WHERE plate = ANY($1::text[])";
      await client.query(`DELETE FROM device_pairing_codes WHERE vehicle_id IN (${ids})`, [safe]);
      await client.query(`DELETE FROM devices WHERE vehicle_id IN (${ids})`, [safe]);
      await client.query("DELETE FROM vehicles WHERE plate = ANY($1::text[])", [safe]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}
