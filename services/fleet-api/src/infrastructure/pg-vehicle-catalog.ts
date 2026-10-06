import type { VehicleCatalogItem } from "@fleet/contracts";
import { z } from "zod";
import type { CreateVehicleResult, VehicleCatalogRepository } from "../application/ports.js";

/** Lo único que hace falta del pool de `pg`. */
export interface CatalogQueryable {
  query(sql: string, params: unknown[]): Promise<{ rows: unknown[] }>;
}

// SQL del catálogo (migraciones 002 y 004). Parametrizado; el tenant es siempre el de la sesión. `vehicles` y `devices` no son hypertables.
// Ni estas sentencias ni sus parámetros se registran: llevan la placa y el alias, que son datos personales.

// `hasActiveDevice`: EXISTS sobre `devices_vehicle_tenant_idx` (vehicle_id, tenant_id). Sin LEFT JOIN: no multiplica filas si algún día un
// vehículo tuviera varios dispositivos activos. La etiqueta vacía o de solo espacios se lee como null.
const LIST_VEHICLES = `
SELECT v.id, v.plate, NULLIF(btrim(v.label), '') AS label, v.created_at,
       EXISTS (SELECT 1 FROM devices d WHERE d.vehicle_id = v.id AND d.tenant_id = v.tenant_id AND d.revoked_at IS NULL) AS has_active_device
  FROM vehicles v
 WHERE v.tenant_id = $1
 ORDER BY v.plate, v.id
 LIMIT $2`;

// `ON CONFLICT ON CONSTRAINT vehicles_tenant_plate_key DO NOTHING`: una placa repetida en el tenant no inserta nada y no lanza (sin
// error de `pg` que filtrar ni transacción abortada); también serializa dos altas simultáneas de la misma placa. Solo cubre ESA unicidad.
const INSERT_VEHICLE = `
INSERT INTO vehicles (id, tenant_id, plate, label) VALUES ($1, $2, $3, $4)
ON CONFLICT ON CONSTRAINT vehicles_tenant_plate_key DO NOTHING
RETURNING id, plate, label, created_at, false AS has_active_device`;

const vehicleRow = z.object({
  id: z.uuid(),
  plate: z.string().min(1),
  label: z.string().min(1).nullable(),
  created_at: z.date(),
  has_active_device: z.boolean(),
});

function toItem(row: unknown): VehicleCatalogItem {
  const parsed = vehicleRow.parse(row);
  return { vehicleId: parsed.id, plate: parsed.plate, label: parsed.label, hasActiveDevice: parsed.has_active_device, createdAt: parsed.created_at.toISOString() };
}

/** Adaptador de `VehicleCatalogRepository` sobre Postgres (rol `fleet_app`). Los errores de `pg` se propagan: nunca llegan al cliente. */
export function createPgVehicleCatalogRepository(pool: CatalogQueryable): VehicleCatalogRepository {
  return {
    async list(tenantId, limit) {
      const { rows } = await pool.query(LIST_VEHICLES, [tenantId, limit]);
      return rows.map(toItem);
    },

    async create(input): Promise<CreateVehicleResult> {
      const { rows } = await pool.query(INSERT_VEHICLE, [input.vehicleId, input.tenantId, input.plate, input.label]);
      const [row] = rows;
      return row === undefined ? { status: "plate_taken" } : { status: "created", vehicle: toItem(row) };
    },
  };
}
