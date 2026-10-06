import { randomUUID } from "node:crypto";
import { createLogger, createPool, databaseAdminConfig, defaultMigrationsDir, loadConfig, migrate } from "@fleet/platform";
import { createTempDatabase, type TempDatabase } from "@fleet/platform/testing";
import type { Pool } from "pg";
import { z } from "zod";

/** Soporte de los tests de integración: una base temporal con las migraciones REALES y el rol de los servicios (`fleet_app`). No forma parte del build. */

export interface IntegrationDatabase {
  /** Pool con el rol `fleet_app`, el mismo de producción. */
  pool: Pool;
  /** Cierra el pool y borra la base temporal. */
  close(): Promise<void>;
}

export async function createIntegrationDatabase(label: string): Promise<IntegrationDatabase> {
  const config = loadConfig(z.object(databaseAdminConfig.shape));
  const logger = createLogger({ service: label, level: "error" });
  const rolePasswords = { fleet_app: config.FLEET_APP_PASSWORD, fleet_ro: config.FLEET_RO_PASSWORD };
  const db: TempDatabase = await createTempDatabase(config.DATABASE_ADMIN_URL);
  try {
    await migrate({ adminUrl: db.adminUrl, migrationsDir: defaultMigrationsDir, rolePasswords, logger });
    const pool = createPool({ connectionString: db.urlFor("fleet_app", rolePasswords.fleet_app), applicationName: label, logger, max: 5 });
    return {
      pool,
      close: async () => {
        await pool.end();
        await db.drop();
      },
    };
  } catch (error) {
    await db.drop();
    throw error;
  }
}

/** Rectángulo en Bogotá (lon -74.075..-74.065, lat 4.705..4.715) con la longitud primero (regla 13). */
export const BOGOTA_SQUARE = "POLYGON((-74.075 4.705, -74.065 4.705, -74.065 4.715, -74.075 4.715, -74.075 4.705))";
/** Otro rectángulo que SOLAPA con `BOGOTA_SQUARE` y contiene el punto `OVERLAP_POINT`. */
export const BOGOTA_OVERLAP = "POLYGON((-74.072 4.708, -74.060 4.708, -74.060 4.718, -74.072 4.718, -74.072 4.708))";
/** Dentro de ambos rectángulos. */
export const OVERLAP_POINT = { lon: -74.07, lat: 4.71 };

export interface Seeder {
  tenant(): Promise<string>;
  vehicle(tenantId: string, plate?: string): Promise<string>;
  zone(tenantId: string, options?: { name?: string; kind?: string; wkt?: string }): Promise<string>;
  state(
    tenantId: string,
    vehicleId: string,
    options?: { movement?: "moving" | "stopped"; stoppedSince?: Date | null; receivedAt?: Date; zoneIds?: string[]; lon?: number; lat?: number },
  ): Promise<void>;
  alert(
    tenantId: string,
    vehicleId: string,
    options?: { alertId?: string; type?: string; zoneId?: string | null; raisedAt?: string; resolvedAt?: Date | null },
  ): Promise<string>;
  user(tenantId: string, options?: { email?: string; name?: string; passwordHash?: string }): Promise<{ userId: string; email: string }>;
}

/** Hash con el formato que exige el CHECK de `users.password_hash` (no es la derivación de ninguna contraseña real). */
export const FAKE_PASSWORD_HASH = "scrypt$32768$8$3$c2FsdHNhbHRzYWx0c2FsdA$ZGVyaXZlZGtleWRlcml2ZWRrZXlkZXJpdmVka2V5ZGVyaXZlZGtleWRlcml2ZWRrZXlkZXJpdmVka2V5";

/** Inserta datos de prueba con UUID propios (no hace falta limpiar entre tests). */
export function createSeeder(pool: Pick<Pool, "query">): Seeder {
  return {
    async tenant() {
      const id = randomUUID();
      await pool.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [id, `Flota ${id}`]);
      return id;
    },

    async vehicle(tenantId, plate) {
      const id = randomUUID();
      await pool.query("INSERT INTO vehicles (id, tenant_id, plate) VALUES ($1, $2, $3)", [id, tenantId, plate ?? `T${id.slice(0, 7).toUpperCase()}`]);
      return id;
    },

    async zone(tenantId, options = {}) {
      const id = randomUUID();
      await pool.query("INSERT INTO zones (zone_id, tenant_id, name, kind, geom) VALUES ($1, $2, $3, $4, ST_GeomFromText($5, 4326))", [
        id,
        tenantId,
        options.name ?? `Zona ${id}`,
        options.kind ?? "critical",
        options.wkt ?? BOGOTA_SQUARE,
      ]);
      return id;
    },

    async state(tenantId, vehicleId, options = {}) {
      const movement = options.movement ?? "moving";
      const stoppedSince = movement === "stopped" ? (options.stoppedSince ?? new Date(Date.now() - 3_600_000)) : null;
      await pool.query(
        `INSERT INTO vehicle_state (vehicle_id, tenant_id, geom, recorded_at, received_at, speed_mps, heading_deg, movement, stopped_since, zone_ids, mocked, low_accuracy)
         VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326), $5, $5, 0, NULL, $6, $7, $8::uuid[], false, false)`,
        [vehicleId, tenantId, options.lon ?? -74.0721, options.lat ?? 4.711, options.receivedAt ?? new Date(), movement, stoppedSince, options.zoneIds ?? []],
      );
    },

    async alert(tenantId, vehicleId, options = {}) {
      const alertId = options.alertId ?? randomUUID();
      await pool.query(
        `INSERT INTO alerts (alert_id, tenant_id, vehicle_id, type, zone_id, started_at, raised_at, resolved_at)
         VALUES ($1, $2, $3, $4, $5, $6::timestamptz - interval '20 minutes', $6::timestamptz, $7)`,
        [alertId, tenantId, vehicleId, options.type ?? "critical_zone_stop", options.zoneId ?? null, options.raisedAt ?? new Date().toISOString(), options.resolvedAt ?? null],
      );
      return alertId;
    },

    async user(tenantId, options = {}) {
      const userId = randomUUID();
      const email = options.email ?? `${userId}@flota.test`;
      await pool.query("INSERT INTO users (user_id, tenant_id, email, name, password_hash) VALUES ($1, $2, $3, $4, $5)", [
        userId,
        tenantId,
        email,
        options.name ?? "Operador",
        options.passwordHash ?? FAKE_PASSWORD_HASH,
      ]);
      return { userId, email };
    },
  };
}
