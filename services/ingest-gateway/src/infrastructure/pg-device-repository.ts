import { z } from "zod";
import type { DeviceRepository } from "../application/ports.js";

/** Lo único que hace falta del pool de `pg`. */
export interface DeviceQueryable {
  query(sql: string, params: unknown[]): Promise<{ rows: unknown[] }>;
}

const deviceRow = z.object({ id: z.uuid(), tenant_id: z.uuid(), vehicle_id: z.uuid() });

// Parametrizada. La búsqueda es por hash entre los no revocados: el índice parcial `devices_active_token_hash_idx`
// (con INCLUDE de la identidad) la resuelve sin leer la tabla. No lleva filtro de tenant: esta consulta es la que
// DERIVA el tenant del token. `devices` no es una hypertable, así que no hay rango de tiempo; devuelve a lo sumo una fila.
const FIND_ACTIVE_BY_TOKEN_HASH = "SELECT id, tenant_id, vehicle_id FROM devices WHERE token_hash = $1 AND revoked_at IS NULL LIMIT 1";

/**
 * Adaptador de `DeviceRepository` sobre Postgres (rol `fleet_app`). Los errores de `pg` se propagan tal cual al
 * llamador, que nunca los envía al cliente.
 */
export function createPgDeviceRepository(pool: DeviceQueryable): DeviceRepository {
  return {
    async findActiveByTokenHash(tokenHash) {
      const { rows } = await pool.query(FIND_ACTIVE_BY_TOKEN_HASH, [tokenHash]);
      const [row] = rows;
      if (row === undefined) return null;
      const device = deviceRow.parse(row);
      return { deviceId: device.id, tenantId: device.tenant_id, vehicleId: device.vehicle_id };
    },
  };
}
