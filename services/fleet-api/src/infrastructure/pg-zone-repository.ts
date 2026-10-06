import { ZONE_KINDS, zoneFeatureSchema } from "@fleet/contracts";
import { z } from "zod";
import type { CreateZoneResult, ZoneRepository } from "../application/ports.js";

/** Lo único que hace falta del pool de `pg`. */
export interface ZoneQueryable {
  query(sql: string, params: unknown[]): Promise<{ rows: unknown[] }>;
}

/** Restricción CHECK de `zones` (migración 005) que falla con un polígono inválido para PostGIS (SQLSTATE 23514). */
const GEOM_VALID_CONSTRAINT = "zones_geom_valid_check";
const CHECK_VIOLATION = "23514";

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

const zoneRow = z.object({ zone_id: z.uuid(), name: z.string().min(1), kind: z.enum(ZONE_KINDS), geometry: z.unknown() });

function isInvalidGeometryViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return "code" in error && error.code === CHECK_VIOLATION && "constraint" in error && error.constraint === GEOM_VALID_CONSTRAINT;
}

/** Adaptador de `ZoneRepository` sobre Postgres (rol `fleet_app`). Los demás errores de `pg` se propagan: nunca llegan al cliente. */
export function createPgZoneRepository(pool: ZoneQueryable): ZoneRepository {
  return {
    async create(input): Promise<CreateZoneResult> {
      let rows: unknown[];
      try {
        ({ rows } = await pool.query(INSERT_ZONE, [input.zoneId, input.tenantId, input.name, input.kind, JSON.stringify(input.geometry)]));
      } catch (error) {
        if (isInvalidGeometryViolation(error)) return { status: "invalid_geometry" };
        throw error;
      }
      const [raw] = rows;
      if (raw === undefined) return { status: "name_taken" };
      const row = zoneRow.parse(raw);
      const zone = zoneFeatureSchema.parse({
        type: "Feature",
        geometry: row.geometry,
        properties: { zoneId: row.zone_id, name: row.name, kind: row.kind },
      });
      return { status: "created", zone };
    },
  };
}
