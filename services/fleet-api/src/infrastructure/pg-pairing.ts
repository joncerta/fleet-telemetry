import { z } from "zod";
import type { CreatePairingCodeResult, PairingCodeRepository, PairingTransaction, PairingUnitOfWork } from "../application/ports.js";

/** Lo único que hace falta de una conexión de `pg` dentro de una transacción. */
export interface PairingClient {
  query(sql: string, params: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  /** Con `true` (o un error) la conexión se destruye en vez de volver al pool. */
  release(destroy?: boolean | Error): void;
}

/** Lo único que hace falta del pool de `pg`. */
export interface PairingPool {
  connect(): Promise<PairingClient>;
  query(sql: string, params: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

// SQL de la vinculación (migraciones 002, 004 y 006). Parametrizado, y el tenant es siempre el de la sesión (alta del código) o el del
// propio código (canje). Ninguna de estas tablas es una hypertable. NINGUNA de estas sentencias ni sus parámetros se registra: llevan el
// hash del código o del token (y el código mismo nunca llega a la base).

// El código solo se crea si el vehículo es del tenant (el SELECT lo comprueba). Con el hash repetido no inserta nada (DO NOTHING).
// `expires_at` sale del reloj de la base: el mismo con el que el canje compara (`expires_at > now()`).
const INSERT_CODE = `
INSERT INTO device_pairing_codes (code_hash, tenant_id, vehicle_id, created_by, expires_at)
SELECT $1::text, v.tenant_id, v.id, $4::uuid, now() + make_interval(mins => $5::int)
  FROM vehicles v
 WHERE v.id = $3::uuid AND v.tenant_id = $2::uuid
ON CONFLICT (code_hash) DO NOTHING
RETURNING expires_at`;

const VEHICLE_EXISTS = "SELECT 1 FROM vehicles WHERE id = $1 AND tenant_id = $2 LIMIT 1";

// Atómico: dos canjes simultáneos del mismo código no pueden ganar los dos (el segundo UPDATE ve `used_at` y no actualiza nada).
const CONSUME_CODE = `
UPDATE device_pairing_codes
   SET used_at = now()
 WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()
RETURNING tenant_id, vehicle_id`;

// FOR NO KEY UPDATE serializa las vinculaciones del mismo vehículo sin chocar con el FOR KEY SHARE de las claves foráneas.
const LOCK_VEHICLE = "SELECT plate FROM vehicles WHERE id = $2 AND tenant_id = $1 FOR NO KEY UPDATE";

const REVOKE_ACTIVE_DEVICES = "UPDATE devices SET revoked_at = now() WHERE vehicle_id = $2 AND tenant_id = $1 AND revoked_at IS NULL";

const INSERT_DEVICE = "INSERT INTO devices (id, tenant_id, vehicle_id, token_hash) VALUES ($1, $2, $3, $4) RETURNING created_at";

const expiresRow = z.object({ expires_at: z.date() });
const consumedRow = z.object({ tenant_id: z.uuid(), vehicle_id: z.uuid() });
const plateRow = z.object({ plate: z.string().min(1) });
const createdRow = z.object({ created_at: z.date() });

/** Adaptador de `PairingCodeRepository` sobre Postgres (rol `fleet_app`). Los errores de `pg` se propagan tal cual. */
export function createPgPairingCodeRepository(pool: Pick<PairingPool, "query">): PairingCodeRepository {
  return {
    async create(input): Promise<CreatePairingCodeResult> {
      const inserted = await pool.query(INSERT_CODE, [input.codeHash, input.tenantId, input.vehicleId, input.createdBy, input.ttlMinutes]);
      const [row] = inserted.rows;
      if (row !== undefined) return { status: "created", expiresAt: expiresRow.parse(row).expires_at };
      // Sin fila: o el vehículo no es del tenant, o el hash ya existía. Se distingue sin revelar nada de otros tenants (se filtra por el del llamador).
      const vehicle = await pool.query(VEHICLE_EXISTS, [input.vehicleId, input.tenantId]);
      return vehicle.rows.length === 0 ? { status: "vehicle_not_found" } : { status: "code_collision" };
    },
  };
}

function transactionOf(client: Pick<PairingClient, "query">): PairingTransaction {
  return {
    async consumeCode(codeHash) {
      const { rows } = await client.query(CONSUME_CODE, [codeHash]);
      const [row] = rows;
      if (row === undefined) return null;
      const consumed = consumedRow.parse(row);
      return { tenantId: consumed.tenant_id, vehicleId: consumed.vehicle_id };
    },

    async lockVehicle(tenantId, vehicleId) {
      const { rows } = await client.query(LOCK_VEHICLE, [tenantId, vehicleId]);
      const [row] = rows;
      return row === undefined ? null : { plate: plateRow.parse(row).plate };
    },

    async revokeActiveDevices(tenantId, vehicleId) {
      await client.query(REVOKE_ACTIVE_DEVICES, [tenantId, vehicleId]);
    },

    async insertDevice(input) {
      const { rows } = await client.query(INSERT_DEVICE, [input.deviceId, input.tenantId, input.vehicleId, input.tokenHash]);
      return { createdAt: createdRow.parse(rows[0]).created_at };
    },
  };
}

/**
 * Adaptador de `PairingUnitOfWork` sobre Postgres (rol `fleet_app`). `run` toma UNA conexión del pool, abre la transacción, ejecuta el
 * trabajo, confirma o revierte y SIEMPRE libera la conexión (`finally`); si el ROLLBACK mismo falla, la conexión se destruye en vez de
 * volver al pool. Los errores de `pg` se propagan tal cual: nunca se envían al cliente.
 */
export function createPgPairingUnitOfWork(pool: Pick<PairingPool, "connect">): PairingUnitOfWork {
  return {
    async run(work) {
      const client = await pool.connect();
      let destroy = false;
      try {
        await client.query("BEGIN", []);
        const result = await work(transactionOf(client));
        await client.query("COMMIT", []);
        return result;
      } catch (error) {
        try {
          await client.query("ROLLBACK", []);
        } catch {
          // Sin poder revertir no se sabe en qué estado quedó la conexión: no se devuelve al pool. El error que sube es el original.
          destroy = true;
        }
        throw error;
      } finally {
        client.release(destroy || undefined);
      }
    },
  };
}
