import { hashPassword } from "@fleet/platform";
import type { Pool } from "pg";
import { SEED_TENANTS, SEED_USERS, SEED_ZONES, seedVehicles, zoneWkt, type SeedTenant, type SeedUser, type SeedVehicle, type SeedZone } from "./seed-data.js";

export interface SeedResult {
  /** Filas que este comando insertó (0 en la segunda corrida: ya existían). */
  tenantsInserted: number;
  vehiclesInserted: number;
  zonesInserted: number;
  usersInserted: number;
}

export interface SeedInput {
  /** Contraseña de los usuarios de demo (`SEED_USER_PASSWORD`). Se guarda solo su hash scrypt, con una sal por usuario. */
  userPassword: string;
  tenants?: readonly SeedTenant[];
  vehicles?: readonly SeedVehicle[];
  zones?: readonly SeedZone[];
  users?: readonly SeedUser[];
  /** Hash de la contraseña. Por defecto `hashPassword` de la plataforma (scrypt); los tests pasan uno más barato. */
  hash?: (password: string) => Promise<string>;
}

/**
 * Siembra los tenants, vehículos, zonas y usuarios de demo. Idempotente: `ON CONFLICT DO NOTHING` (por `id`, por nombre,
 * por placa y por correo sin distinguir mayúsculas), así que una segunda corrida no cambia nada ni pisa lo que alguien editó a
 * mano; en particular, cambiar `SEED_USER_PASSWORD` NO cambia la contraseña de un usuario ya sembrado. Todo en una transacción
 * sobre el mismo client.
 */
export async function runSeed(pool: Pick<Pool, "connect">, input: SeedInput): Promise<SeedResult> {
  const tenants = input.tenants ?? SEED_TENANTS;
  const vehicles = input.vehicles ?? seedVehicles(tenants);
  const zones = input.zones ?? SEED_ZONES;
  const users = input.users ?? SEED_USERS;
  const hash = input.hash ?? ((password: string) => hashPassword(password));
  // Cada usuario con su propia sal. Se calcula antes de abrir la transacción: scrypt tarda y no debe retener la conexión.
  const passwordHashes = await Promise.all(users.map(() => hash(input.userPassword)));

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
    const zoneResult = await client.query(
      `INSERT INTO zones (zone_id, tenant_id, name, kind, geom)
       SELECT z.zone_id, z.tenant_id, z.name, z.kind, ST_GeomFromText(z.wkt, 4326)
       FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::text[]) AS z(zone_id, tenant_id, name, kind, wkt)
       ON CONFLICT DO NOTHING`,
      [zones.map((z) => z.zoneId), zones.map((z) => z.tenantId), zones.map((z) => z.name), zones.map((z) => z.kind), zones.map(zoneWkt)],
    );
    const userResult = await client.query(
      "INSERT INTO users (user_id, tenant_id, email, name, password_hash) SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::text[]) ON CONFLICT DO NOTHING",
      [users.map((u) => u.userId), users.map((u) => u.tenantId), users.map((u) => u.email), users.map((u) => u.name), passwordHashes],
    );
    await client.query("COMMIT");
    return {
      tenantsInserted: tenantResult.rowCount ?? 0,
      vehiclesInserted: vehicleResult.rowCount ?? 0,
      zonesInserted: zoneResult.rowCount ?? 0,
      usersInserted: userResult.rowCount ?? 0,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
