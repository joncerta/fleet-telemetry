import {
  alertSchema,
  ALERT_TYPES,
  zoneFeatureCollectionSchema,
  ZONE_KINDS,
  type ZoneFeatureCollection,
} from "@fleet/contracts";
import { z } from "zod";
import type {
  AlertQuery,
  AlertReader,
  AlertRecord,
  StoppedVehicleQuery,
  StoppedVehicleReader,
  StoppedVehicleRow,
  SummaryReader,
  VehicleStatusCounts,
  ZoneReader,
} from "../application/ports.js";

/** Lo único que hace falta del pool de `pg`. */
export interface FleetReadQueryable {
  query(sql: string, params: unknown[]): Promise<{ rows: unknown[] }>;
}

/** Tope de zonas por respuesta (todo listado lleva LIMIT). Un tenant con más zonas que esto es un caso nuevo, no algo para truncar en silencio. */
export const MAX_ZONES = 1_000;

// SQL del read model (migraciones 005 y 002). Toda sentencia:
// - está parametrizada (`$1`..): ningún valor de la petición entra en el texto del SQL;
// - filtra por `tenant_id`, que es el de la sesión (regla 4), en la tabla principal Y en cada JOIN (las claves foráneas compuestas lo
//   garantizan, pero el filtro se escribe igual: defensa en profundidad);
// - lleva LIMIT cuando es un listado. Ninguna consulta toca `telemetry` (la hypertable): el read model son tablas normales, sin rango de tiempo;
// - lee la geometría con ST_X (longitud) y ST_Y (latitud) y ST_AsGeoJSON, que escribe `[lng, lat]` (regla 13).
// bigint llega como string desde `pg` y se convierte explícitamente donde se lee.

// Los tres conteos particionan los vehículos del tenant: sin señal es `received_at` ANTERIOR al corte, o no haber reportado nunca.
const COUNT_VEHICLE_STATUS = `
SELECT count(*) FILTER (WHERE s.vehicle_id IS NOT NULL AND s.received_at >= $2 AND s.movement = 'moving') AS moving,
       count(*) FILTER (WHERE s.vehicle_id IS NOT NULL AND s.received_at >= $2 AND s.movement = 'stopped') AS stopped,
       count(*) FILTER (WHERE s.vehicle_id IS NULL OR s.received_at < $2) AS no_signal
  FROM vehicles v
  LEFT JOIN vehicle_state s ON s.vehicle_id = v.id AND s.tenant_id = v.tenant_id
 WHERE v.tenant_id = $1`;

const COUNT_ACTIVE_ALERTS = "SELECT count(*) AS active FROM alerts WHERE tenant_id = $1 AND resolved_at IS NULL";

// Detenidos con señal, los que llevan más tiempo primero (índice parcial `vehicle_state_stopped_idx`). El filtro por tipo de zona es un
// EXISTS (el filtro va ANTES del LIMIT), y `zones` trae solo las zonas del tipo pedido (todas, si no se filtró): la elección de cuál
// mostrar es una regla de negocio (`pickDisplayZone`), no de la consulta.
const FIND_STOPPED = `
SELECT s.vehicle_id, v.plate, s.stopped_since, ST_X(s.geom) AS lon, ST_Y(s.geom) AS lat,
       (SELECT coalesce(json_agg(json_build_object('zoneId', z.zone_id, 'name', z.name, 'kind', z.kind) ORDER BY z.zone_id), '[]'::json)
          FROM zones z
         WHERE z.tenant_id = s.tenant_id AND z.zone_id = ANY(s.zone_ids) AND ($5::text IS NULL OR z.kind = $5::text)) AS zones
  FROM vehicle_state s
  JOIN vehicles v ON v.id = s.vehicle_id AND v.tenant_id = s.tenant_id
 WHERE s.tenant_id = $1
   AND s.movement = 'stopped'
   AND s.received_at >= $2
   AND s.stopped_since <= $3
   AND ($5::text IS NULL OR EXISTS (SELECT 1 FROM zones z WHERE z.tenant_id = s.tenant_id AND z.zone_id = ANY(s.zone_ids) AND z.kind = $5::text))
 ORDER BY s.stopped_since ASC, s.vehicle_id ASC
 LIMIT $4`;

/** Fragmentos del estado de las alertas: una ALLOWLIST. Lo que va al texto del SQL sale de aquí, nunca de la petición. */
const ALERT_STATUS_FILTER = {
  active: "AND a.resolved_at IS NULL",
  all: "",
} as const satisfies Record<AlertQuery["status"], string>;

// Keyset (raised_at DESC, alert_id DESC), el orden de los índices `alerts_active_idx` y `alerts_tenant_raised_idx`. `raised_at` tiene
// precisión de microsegundos y un `Date` de JavaScript solo milisegundos: el cursor se lee como TEXTO con microsegundos (`raised_at_cursor`)
// y vuelve como texto, para no saltarse ni repetir alertas que coinciden en el mismo milisegundo.
const findAlertsSql = (status: AlertQuery["status"]): string => `
SELECT a.alert_id, a.vehicle_id, v.plate, a.type, a.zone_id, z.name AS zone_name,
       a.started_at, a.raised_at, a.resolved_at, a.seq::text AS seq,
       to_char(a.raised_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS raised_at_cursor
  FROM alerts a
  JOIN vehicles v ON v.id = a.vehicle_id AND v.tenant_id = a.tenant_id
  LEFT JOIN zones z ON z.zone_id = a.zone_id AND z.tenant_id = a.tenant_id
 WHERE a.tenant_id = $1 ${ALERT_STATUS_FILTER[status]}
   AND ($2::timestamptz IS NULL OR (a.raised_at, a.alert_id) < ($2::timestamptz, $3::uuid))
 ORDER BY a.raised_at DESC, a.alert_id DESC
 LIMIT $4`;

const FIND_ALERTS = { active: findAlertsSql("active"), all: findAlertsSql("all") } as const;

// ST_ForcePolygonCCW: el anillo exterior en sentido antihorario, como pide RFC 7946. 6 decimales son ~0,1 m.
const FIND_ZONES = `
SELECT z.zone_id, z.name, z.kind, ST_AsGeoJSON(ST_ForcePolygonCCW(z.geom), 6)::json AS geometry
  FROM zones z
 WHERE z.tenant_id = $1
 ORDER BY z.name, z.zone_id
 LIMIT $2`;

const countRow = z.object({ moving: z.coerce.number().int().min(0), stopped: z.coerce.number().int().min(0), no_signal: z.coerce.number().int().min(0) });
const activeRow = z.object({ active: z.coerce.number().int().min(0) });

const stoppedRow = z.object({
  vehicle_id: z.uuid(),
  plate: z.string().min(1),
  stopped_since: z.date(),
  lon: z.number(),
  lat: z.number(),
  zones: z.array(z.object({ zoneId: z.uuid(), name: z.string().min(1), kind: z.enum(ZONE_KINDS) })),
});

const alertRow = z.object({
  alert_id: z.uuid(),
  vehicle_id: z.uuid(),
  plate: z.string(),
  type: z.enum(ALERT_TYPES),
  zone_id: z.uuid().nullable(),
  zone_name: z.string().nullable(),
  started_at: z.date(),
  raised_at: z.date(),
  resolved_at: z.date().nullable(),
  seq: z.string(),
  raised_at_cursor: z.string(),
});

const zoneRow = z.object({ zone_id: z.uuid(), name: z.string(), kind: z.enum(ZONE_KINDS), geometry: z.unknown() });

/**
 * Lectura del read model sobre Postgres (rol `fleet_app`; solo SELECT). Implementa los cuatro lectores. Los errores de `pg` se
 * propagan tal cual al llamador, que nunca los envía al cliente. Posición, placa y estado son datos personales: no se registran.
 */
export function createPgFleetReadRepository(pool: FleetReadQueryable): SummaryReader & StoppedVehicleReader & AlertReader & ZoneReader {
  return {
    async countVehicleStatus(tenantId: string, noSignalBefore: Date): Promise<VehicleStatusCounts> {
      const { rows } = await pool.query(COUNT_VEHICLE_STATUS, [tenantId, noSignalBefore]);
      const row = countRow.parse(rows[0]);
      return { moving: row.moving, stopped: row.stopped, noSignal: row.no_signal };
    },

    async countActiveAlerts(tenantId: string): Promise<number> {
      const { rows } = await pool.query(COUNT_ACTIVE_ALERTS, [tenantId]);
      return activeRow.parse(rows[0]).active;
    },

    async findStopped(query: StoppedVehicleQuery): Promise<StoppedVehicleRow[]> {
      const { rows } = await pool.query(FIND_STOPPED, [query.tenantId, query.signalSince, query.stoppedAtOrBefore, query.limit, query.zoneKind ?? null]);
      return rows.map((raw) => {
        const row = stoppedRow.parse(raw);
        return { vehicleId: row.vehicle_id, plate: row.plate, stoppedSince: row.stopped_since, lon: row.lon, lat: row.lat, zones: row.zones };
      });
    },

    async findAlerts(query: AlertQuery): Promise<AlertRecord[]> {
      const { rows } = await pool.query(FIND_ALERTS[query.status], [query.tenantId, query.after?.raisedAt ?? null, query.after?.alertId ?? null, query.limit]);
      return rows.map((raw) => {
        const row = alertRow.parse(raw);
        return {
          // Contra el esquema del contrato: un dato inválido en la base falla fuerte aquí, no en el cliente.
          alert: alertSchema.parse({
            alertId: row.alert_id,
            vehicleId: row.vehicle_id,
            plate: row.plate,
            type: row.type,
            zoneId: row.zone_id,
            zoneName: row.zone_name,
            startedAt: row.started_at.toISOString(),
            raisedAt: row.raised_at.toISOString(),
            resolvedAt: row.resolved_at === null ? null : row.resolved_at.toISOString(),
            seq: row.seq,
          }),
          cursor: { raisedAt: row.raised_at_cursor, alertId: row.alert_id },
        };
      });
    },

    async findZones(tenantId: string): Promise<ZoneFeatureCollection> {
      const { rows } = await pool.query(FIND_ZONES, [tenantId, MAX_ZONES]);
      return zoneFeatureCollectionSchema.parse({
        type: "FeatureCollection",
        features: rows.map((raw) => {
          const row = zoneRow.parse(raw);
          return { type: "Feature", geometry: row.geometry, properties: { zoneId: row.zone_id, name: row.name, kind: row.kind } };
        }),
      });
    },
  };
}
