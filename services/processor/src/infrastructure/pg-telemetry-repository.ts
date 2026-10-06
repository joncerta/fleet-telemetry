import type { TelemetryRawEvent } from "@fleet/contracts";
import type { TelemetryRepository } from "../application/ports.js";

/** Lo único que hace falta del pool de `pg`. */
export interface TelemetryQueryable {
  query(sql: string, params: unknown[]): Promise<{ rowCount: number | null }>;
}

// Un solo INSERT por lote: cada parámetro es un arreglo con una posición por evento y `unnest` los vuelve filas.
// - Parametrizado (`$1`..`$14`): ningún valor del evento entra en el texto del SQL.
// - `ON CONFLICT (event_id, recorded_at) DO NOTHING`: es el índice único de la hypertable (incluye la columna de
//   tiempo). Idempotente de punta a punta (regla 5): un reenvío o una reentrega de Kafka es un no-op, también si el
//   mismo punto se repite dentro del lote.
// - `ST_MakePoint(lon, lat)`: LONGITUD primero, SRID 4326 (regla 13).
// - `recorded_at` y `received_at` llegan como texto ISO 8601 con offset y se convierten a `timestamptz`: Postgres los
//   guarda en UTC (la sesión del pool también es UTC). El tiempo del punto es el del fix GPS del dispositivo; la hora
//   del servidor (gateway) va aparte en `received_at`.
// - `tenant_id`, `device_id` y `vehicle_id` son los del evento, que el gateway tomó del token verificado: nunca del
//   payload del dispositivo.
// Es una escritura, no una lectura: no lleva rango de tiempo ni LIMIT, y una sola sentencia es atómica (no hace falta
// transacción).
const INSERT_TELEMETRY = `
INSERT INTO telemetry (
  event_id, tenant_id, vehicle_id, device_id, recorded_at, received_at, geom,
  speed_mps, heading_deg, accuracy_m, altitude_m, mocked, low_accuracy
)
SELECT
  t.event_id, t.tenant_id, t.vehicle_id, t.device_id, t.recorded_at, t.received_at,
  ST_SetSRID(ST_MakePoint(t.lon, t.lat), 4326),
  t.speed_mps, t.heading_deg, t.accuracy_m, t.altitude_m, t.mocked, t.low_accuracy
FROM unnest(
  $1::uuid[], $2::uuid[], $3::uuid[], $4::uuid[], $5::timestamptz[], $6::timestamptz[],
  $7::float8[], $8::float8[], $9::float8[], $10::float8[], $11::float8[], $12::float8[],
  $13::boolean[], $14::boolean[]
) AS t(
  event_id, tenant_id, vehicle_id, device_id, recorded_at, received_at,
  lon, lat, speed_mps, heading_deg, accuracy_m, altitude_m, mocked, low_accuracy
)
ON CONFLICT (event_id, recorded_at) DO NOTHING`;

/**
 * Adaptador de `TelemetryRepository` sobre Postgres (rol `fleet_app`). Los errores de `pg` se propagan tal cual: el caso
 * de uso los clasifica y nunca los envía fuera del servicio.
 */
export function createPgTelemetryRepository(pool: TelemetryQueryable): TelemetryRepository {
  return {
    async insertBatch(events) {
      if (events.length === 0) return { inserted: 0 };
      const { rowCount } = await pool.query(INSERT_TELEMETRY, columnsOf(events));
      // `rowCount` cuenta solo las filas insertadas: las que `ON CONFLICT DO NOTHING` ignoró no suman.
      return { inserted: rowCount ?? 0 };
    },
  };
}

function columnsOf(events: readonly TelemetryRawEvent[]): unknown[] {
  return [
    events.map((event) => event.point.eventId),
    events.map((event) => event.tenantId),
    events.map((event) => event.point.vehicleId),
    events.map((event) => event.deviceId),
    events.map((event) => event.point.recordedAt),
    events.map((event) => event.receivedAt),
    events.map((event) => event.point.lon),
    events.map((event) => event.point.lat),
    events.map((event) => event.point.speedMps),
    events.map((event) => event.point.headingDeg),
    events.map((event) => event.point.accuracyM),
    events.map((event) => event.point.altitudeM ?? null),
    events.map((event) => event.point.mocked),
    events.map((event) => event.point.lowAccuracy),
  ];
}
