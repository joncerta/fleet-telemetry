import { ZONE_KINDS, zoneFeatureSchema } from "@fleet/contracts";
import { z } from "zod";
import type { CreateZoneResult, ZoneRepository } from "../application/ports.js";

/** Lo único que hace falta de un cliente de `pg`. */
export interface ZoneClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  release(): void;
}

/** Lo único que hace falta del pool de `pg`: un cliente propio, porque el conteo y el alta van en UNA transacción. */
export interface ZonePool {
  connect(): Promise<ZoneClient>;
}

/** Restricción CHECK de `zones` (migración 005) que falla con un polígono inválido para PostGIS (SQLSTATE 23514). */
const GEOM_VALID_CONSTRAINT = "zones_geom_valid_check";
const CHECK_VIOLATION = "23514";

// Serializa las altas de un tenant: el lock de asesor (de transacción) se libera solo al COMMIT o ROLLBACK. Las altas de OTROS tenants no se esperan
// (salvo una colisión de `hashtext`, que solo cuesta una espera). Va en una sentencia aparte de la del conteo: en READ COMMITTED cada sentencia toma
// su propia instantánea, así que el conteo ve el alta que acaba de confirmar quien tenía el lock (en un solo CTE, la instantánea sería anterior).
const LOCK_TENANT_ZONES = "SELECT pg_advisory_xact_lock(hashtext($1::text))";

// Zonas del tenant y si ya existe el nombre (mismo criterio que `zones_tenant_name_key`: igualdad exacta). Ninguna fila = 0 zonas.
const COUNT_ZONES = "SELECT count(*)::int AS total, coalesce(bool_or(name = $2), false) AS name_exists FROM zones WHERE tenant_id = $1";

// SQL del alta de zonas (migración 005). Parametrizado: el GeoJSON viaja como UN parámetro de texto (`$5::text`, sin ambigüedad de sobrecarga),
// se interpreta con SRID 4326 y el tenant es siempre el de la sesión. `ON CONFLICT ON CONSTRAINT zones_tenant_name_key DO NOTHING`: un nombre
// repetido en el tenant no inserta nada y no lanza (sin error de `pg` que filtrar); también serializa dos altas simultáneas del mismo nombre.
// Un polígono inválido SÍ lanza (el CHECK `zones_geom_valid_check` se evalúa antes del arbitraje del conflicto): se traduce abajo.
// La geometría se devuelve con el mismo formato que `GET /v1/zones/geojson` (anillo exterior antihorario, 6 decimales).
// Ni la sentencia ni sus parámetros se registran en logs.
const INSERT_ZONE = `
INSERT INTO zones (zone_id, tenant_id, name, kind, geom)
VALUES ($1, $2, $3, $4, ST_SetSRID(ST_GeomFromGeoJSON($5::text), 4326))
ON CONFLICT ON CONSTRAINT zones_tenant_name_key DO NOTHING
RETURNING zone_id, name, kind, ST_AsGeoJSON(ST_ForcePolygonCCW(geom), 6)::json AS geometry`;

const countRow = z.object({ total: z.number().int().min(0), name_exists: z.boolean() });
const zoneRow = z.object({ zone_id: z.uuid(), name: z.string().min(1), kind: z.enum(ZONE_KINDS), geometry: z.unknown() });

function isInvalidGeometryViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return "code" in error && error.code === CHECK_VIOLATION && "constraint" in error && error.constraint === GEOM_VALID_CONSTRAINT;
}

/**
 * Adaptador de `ZoneRepository` sobre Postgres (rol `fleet_app`). Una transacción por alta: lock del tenant, conteo y alta. Los demás errores de
 * `pg` se propagan: nunca llegan al cliente. `release()` siempre en `finally`.
 */
export function createPgZoneRepository(pool: ZonePool): ZoneRepository {
  return {
    async create(input): Promise<CreateZoneResult> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        try {
          await client.query(LOCK_TENANT_ZONES, [input.tenantId]);
          const { rows: counted } = await client.query(COUNT_ZONES, [input.tenantId, input.name]);
          const count = countRow.parse(counted[0]);
          if (count.name_exists) return await finish(client, { status: "name_taken" });
          if (count.total >= input.maxPerTenant) return await finish(client, { status: "limit_reached" });

          const { rows } = await client.query(INSERT_ZONE, [input.zoneId, input.tenantId, input.name, input.kind, JSON.stringify(input.geometry)]);
          const [raw] = rows;
          // `ON CONFLICT DO NOTHING` es la red de seguridad: con el lock no debería haber conflicto.
          if (raw === undefined) return await finish(client, { status: "name_taken" });
          const row = zoneRow.parse(raw);
          const zone = zoneFeatureSchema.parse({
            type: "Feature",
            geometry: row.geometry,
            properties: { zoneId: row.zone_id, name: row.name, kind: row.kind },
          });
          return await finish(client, { status: "created", zone });
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          if (isInvalidGeometryViolation(error)) return { status: "invalid_geometry" };
          throw error;
        }
      } finally {
        client.release();
      }
    },
  };
}

async function finish(client: ZoneClient, result: CreateZoneResult): Promise<CreateZoneResult> {
  await client.query("COMMIT");
  return result;
}
