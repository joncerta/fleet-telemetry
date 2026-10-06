import type { Pool } from "pg";
import { SEED_TENANTS, seedVehicles, type SeedTenant, type SeedVehicle } from "./seed-data.js";

export interface SeedResult {
  /** Filas que este comando insertó (0 en la segunda corrida: ya existían). */
  tenantsInserted: number;
  vehiclesInserted: number;
}

/**
 * Siembra los tenants y vehículos de demo. Idempotente: `ON CONFLICT DO NOTHING` (por `id`, por nombre y por
 * placa), así que una segunda corrida no cambia nada ni pisa lo que alguien editó a mano. Todo en una transacción
 * sobre el mismo client.
 */
export async function runSeed(
  pool: Pick<Pool, "connect">,
  tenants: readonly SeedTenant[] = SEED_TENANTS,
  vehicles: readonly SeedVehicle[] = seedVehicles(tenants),
): Promise<SeedResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tenantResult = await client.query(
      "INSERT INTO tenants (id, name) SELECT * FROM unnest($1::uuid[], $2::text[]) ON CONFLICT DO NOTHING",
      [tenants.map((t) => t.id), tenants.map((t) => t.name)],
    );
    const vehicleResult = await client.query(
      "INSERT INTO vehicles (id, tenant_id, plate, label) SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::text[]) ON CONFLICT DO NOTHING",
      [vehicles.map((v) => v.id), vehicles.map((v) => v.tenantId), vehicles.map((v) => v.plate), vehicles.map((v) => v.label)],
    );
    await client.query("COMMIT");
    return { tenantsInserted: tenantResult.rowCount ?? 0, vehiclesInserted: vehicleResult.rowCount ?? 0 };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
