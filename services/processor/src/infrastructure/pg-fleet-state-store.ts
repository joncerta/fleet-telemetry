import { MOVEMENTS, ZONE_KINDS, ALERT_TYPES, type Alert, type VehicleState } from "@fleet/contracts";
import { z } from "zod";
import type { AlertWrite, FleetStateTransaction, FleetStateUnitOfWork, PublishableFleet, VehicleStateWrite } from "../application/ports.js";
import type { OpenAlert, VehicleSnapshot, ZoneRef } from "../domain/vehicle-state.js";

/** Lo único que hace falta de una conexión de `pg` dentro de una transacción. */
export interface FleetStateClient {
  query(sql: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  /** Con `true` (o un error) la conexión se destruye en vez de volver al pool. */
  release(destroy?: boolean | Error): void;
}

/** Lo único que hace falta del pool de `pg`. */
export interface FleetStatePool {
  connect(): Promise<FleetStateClient>;
}

// SQL del read model de la flota (migración 005). Toda sentencia:
// - está parametrizada (`$1`..): ningún valor del evento entra en el texto del SQL;
// - filtra por `tenant_id` = `$1` (el del evento, que el gateway tomó del token verificado): regla 4;
// - construye puntos con `ST_MakePoint(lon, lat)` (LONGITUD primero) y SRID 4326 (regla 13);
// - recibe los lotes como arreglos paralelos y `unnest` (una sentencia por operación, no una por vehículo).
// Ningún listado necesita LIMIT ni keyset: cada consulta se acota por `vehicle_id = ANY($2)` (a lo sumo los vehículos de un tramo de Kafka,
// <= PROCESSOR_INSERT_CHUNK_SIZE) y no es una lista que crezca con el tiempo; `telemetry` (la hypertable) no se consulta aquí.

/** Estado previo con la fila bloqueada: dos réplicas que se crucen (reasignación de particiones) no pisan el estado una de la otra. */
const LOCK_STATES = `
SELECT vehicle_id, ST_X(geom) AS lon, ST_Y(geom) AS lat, recorded_at, received_at, speed_mps, heading_deg,
       movement, stopped_since, zone_ids, mocked, low_accuracy
  FROM vehicle_state
 WHERE tenant_id = $1 AND vehicle_id = ANY($2::uuid[])
 ORDER BY vehicle_id
   FOR UPDATE`;

const LOCK_OPEN_ALERTS = `
SELECT alert_id, vehicle_id, type, zone_id, started_at
  FROM alerts
 WHERE tenant_id = $1 AND vehicle_id = ANY($2::uuid[]) AND resolved_at IS NULL
 ORDER BY alert_id
   FOR UPDATE`;

// Qué zonas del tenant contienen cada posición, en UNA consulta (WITH ORDINALITY conserva el orden de las posiciones).
// ST_Covers cuenta también el borde del polígono y usa el índice GIST de \`zones.geom\`.
const ZONES_COVERING = `
SELECT p.idx::int AS idx, z.zone_id, z.kind
  FROM unnest($2::float8[], $3::float8[]) WITH ORDINALITY AS p(lon, lat, idx)
  JOIN zones z ON z.tenant_id = $1 AND ST_Covers(z.geom, ST_SetSRID(ST_MakePoint(p.lon, p.lat), 4326))
 ORDER BY p.idx, z.zone_id`;

// Una fila por vehículo (PK `vehicle_id`).
// - El DEFAULT de `seq` solo corre en un INSERT: en el DO UPDATE hay que escribir `seq = nextval(...)` explícito (migración 005), o la
//   fila conservaría su `seq` anterior y los clientes descartarían la actualización por vieja.
// - El WHERE del DO UPDATE es una defensa en el propio SQL: nunca retrocede `recorded_at` (aunque el bloqueo FOR UPDATE ya lo evita) y
//   nunca toca una fila de otro tenant. Una fila que no cumple se deja como está.
// - `zone_ids` llega como texto separado por comas (un arreglo de arreglos de largo variable no cabe en `unnest`).
const UPSERT_STATES = `
INSERT INTO vehicle_state (
  vehicle_id, tenant_id, geom, recorded_at, received_at, speed_mps, heading_deg, movement, stopped_since, zone_ids, mocked, low_accuracy
)
SELECT
  s.vehicle_id, $1::uuid, ST_SetSRID(ST_MakePoint(s.lon, s.lat), 4326), s.recorded_at, s.received_at, s.speed_mps, s.heading_deg,
  s.movement, s.stopped_since, COALESCE(string_to_array(NULLIF(s.zone_ids, ''), ',')::uuid[], '{}'::uuid[]), s.mocked, s.low_accuracy
FROM unnest(
  $2::uuid[], $3::float8[], $4::float8[], $5::timestamptz[], $6::timestamptz[], $7::float8[], $8::float8[],
  $9::text[], $10::timestamptz[], $11::text[], $12::boolean[], $13::boolean[]
) AS s(vehicle_id, lon, lat, recorded_at, received_at, speed_mps, heading_deg, movement, stopped_since, zone_ids, mocked, low_accuracy)
ON CONFLICT (vehicle_id) DO UPDATE SET
  geom = EXCLUDED.geom,
  recorded_at = EXCLUDED.recorded_at,
  received_at = EXCLUDED.received_at,
  speed_mps = EXCLUDED.speed_mps,
  heading_deg = EXCLUDED.heading_deg,
  movement = EXCLUDED.movement,
  stopped_since = EXCLUDED.stopped_since,
  zone_ids = EXCLUDED.zone_ids,
  mocked = EXCLUDED.mocked,
  low_accuracy = EXCLUDED.low_accuracy,
  seq = nextval('fleet_event_seq'),
  updated_at = now()
WHERE vehicle_state.tenant_id = EXCLUDED.tenant_id AND vehicle_state.recorded_at < EXCLUDED.recorded_at`;

// \`alert_id\` es un uuid v5 determinista: reprocesar el mismo hecho es un no-op. RETURNING devuelve solo las filas realmente insertadas.
// \`seq\` toma el DEFAULT (nextval) del INSERT.
const INSERT_ALERTS = `
INSERT INTO alerts (alert_id, tenant_id, vehicle_id, type, zone_id, started_at, raised_at, resolved_at)
SELECT a.alert_id, $1::uuid, a.vehicle_id, a.type, a.zone_id, a.started_at, a.raised_at, a.resolved_at
FROM unnest($2::uuid[], $3::uuid[], $4::text[], $5::uuid[], $6::timestamptz[], $7::timestamptz[], $8::timestamptz[])
  AS a(alert_id, vehicle_id, type, zone_id, started_at, raised_at, resolved_at)
ON CONFLICT (alert_id) DO NOTHING
RETURNING alert_id`;

// La resolución es un UPDATE: el DEFAULT de \`seq\` no corre, se escribe explícito. Solo resuelve las que siguen activas.
const RESOLVE_ALERTS = `
UPDATE alerts AS a
   SET resolved_at = r.resolved_at, seq = nextval('fleet_event_seq')
  FROM unnest($2::uuid[], $3::timestamptz[]) AS r(alert_id, resolved_at)
 WHERE a.alert_id = r.alert_id AND a.tenant_id = $1 AND a.resolved_at IS NULL
RETURNING a.alert_id`;

// Lo que se publica: el estado vigente (con la placa de \`vehicles\`) y las alertas activas o resueltas desde \`$3\` (con el nombre de la zona).
// \`seq\` es bigint: \`pg\` lo entrega como string y así se queda (el contrato lo serializa como string).
const READ_STATES = `
SELECT vs.vehicle_id, v.plate, ST_X(vs.geom) AS lon, ST_Y(vs.geom) AS lat, vs.recorded_at, vs.received_at, vs.speed_mps, vs.heading_deg,
       vs.movement, vs.stopped_since, vs.zone_ids, vs.mocked, vs.low_accuracy, vs.seq::text AS seq
  FROM vehicle_state vs
  JOIN vehicles v ON v.id = vs.vehicle_id AND v.tenant_id = vs.tenant_id
 WHERE vs.tenant_id = $1 AND vs.vehicle_id = ANY($2::uuid[])
 ORDER BY vs.vehicle_id`;

const READ_ALERTS = `
SELECT a.alert_id, a.vehicle_id, v.plate, a.type, a.zone_id, z.name AS zone_name, a.started_at, a.raised_at, a.resolved_at, a.seq::text AS seq
  FROM alerts a
  JOIN vehicles v ON v.id = a.vehicle_id AND v.tenant_id = a.tenant_id
  LEFT JOIN zones z ON z.zone_id = a.zone_id AND z.tenant_id = a.tenant_id
 WHERE a.tenant_id = $1 AND a.vehicle_id = ANY($2::uuid[]) AND (a.resolved_at IS NULL OR a.resolved_at >= $3::timestamptz)
 ORDER BY a.seq`;

// Filas de la base: se validan en el borde del adaptador (nada de `any` ni de casts). \`pg\` entrega \`timestamptz\` como Date y \`uuid[]\`
// como arreglo de strings. Los ids se leen como string (la columna ya es uuid); el contrato los vuelve a validar al publicar.
const date = z.date();
const stateRow = z.object({
  vehicle_id: z.string(),
  lon: z.number(),
  lat: z.number(),
  recorded_at: date,
  received_at: date,
  speed_mps: z.number().nullable(),
  heading_deg: z.number().nullable(),
  movement: z.enum(MOVEMENTS),
  stopped_since: date.nullable(),
  zone_ids: z.array(z.string()),
  mocked: z.boolean(),
  low_accuracy: z.boolean(),
});
const openAlertRow = z.object({ alert_id: z.string(), vehicle_id: z.string(), type: z.enum(ALERT_TYPES), zone_id: z.string().nullable(), started_at: date });
const zoneRow = z.object({ idx: z.number().int(), zone_id: z.string(), kind: z.enum(ZONE_KINDS) });
const publishableStateRow = stateRow.extend({ plate: z.string(), seq: z.string() });
const publishableAlertRow = z.object({
  alert_id: z.string(),
  vehicle_id: z.string(),
  plate: z.string(),
  type: z.enum(ALERT_TYPES),
  zone_id: z.string().nullable(),
  zone_name: z.string().nullable(),
  started_at: date,
  raised_at: date,
  resolved_at: date.nullable(),
  seq: z.string(),
});
const idRow = z.object({ alert_id: z.string() });

const iso = (value: Date): string => value.toISOString();

function transactionOf(client: FleetStateClient): FleetStateTransaction {
  const query = (sql: string, params: unknown[]) => client.query(sql, params);

  return {
    async lockVehicleStates(tenantId, vehicleIds) {
      const { rows } = await query(LOCK_STATES, [tenantId, vehicleIds]);
      const states = new Map<string, VehicleSnapshot>();
      for (const row of rows.map((candidate) => stateRow.parse(candidate))) {
        states.set(row.vehicle_id, {
          recordedAt: iso(row.recorded_at),
          receivedAt: iso(row.received_at),
          lon: row.lon,
          lat: row.lat,
          speedMps: row.speed_mps,
          headingDeg: row.heading_deg,
          movement: row.movement,
          stoppedSince: row.stopped_since === null ? null : iso(row.stopped_since),
          zoneIds: row.zone_ids,
          mocked: row.mocked,
          lowAccuracy: row.low_accuracy,
        });
      }
      return states;
    },

    async lockOpenAlerts(tenantId, vehicleIds) {
      const { rows } = await query(LOCK_OPEN_ALERTS, [tenantId, vehicleIds]);
      const byVehicle = new Map<string, OpenAlert[]>();
      for (const row of rows.map((candidate) => openAlertRow.parse(candidate))) {
        const open: OpenAlert = { alertId: row.alert_id, type: row.type, zoneId: row.zone_id, startedAt: iso(row.started_at) };
        byVehicle.set(row.vehicle_id, [...(byVehicle.get(row.vehicle_id) ?? []), open]);
      }
      return byVehicle;
    },

    async zonesCovering(tenantId, positions) {
      const perPosition: ZoneRef[][] = positions.map(() => []);
      if (positions.length === 0) return perPosition;
      const { rows } = await query(ZONES_COVERING, [tenantId, positions.map((position) => position.lon), positions.map((position) => position.lat)]);
      for (const row of rows.map((candidate) => zoneRow.parse(candidate))) {
        // `idx` es 1-based (WITH ORDINALITY).
        perPosition[row.idx - 1]?.push({ zoneId: row.zone_id, kind: row.kind });
      }
      return perPosition;
    },

    async upsertVehicleStates(tenantId, states: readonly VehicleStateWrite[]) {
      if (states.length === 0) return;
      await query(UPSERT_STATES, [
        tenantId,
        states.map(({ vehicleId }) => vehicleId),
        states.map(({ snapshot }) => snapshot.lon),
        states.map(({ snapshot }) => snapshot.lat),
        states.map(({ snapshot }) => snapshot.recordedAt),
        states.map(({ snapshot }) => snapshot.receivedAt),
        states.map(({ snapshot }) => snapshot.speedMps),
        states.map(({ snapshot }) => snapshot.headingDeg),
        states.map(({ snapshot }) => snapshot.movement),
        states.map(({ snapshot }) => snapshot.stoppedSince),
        states.map(({ snapshot }) => snapshot.zoneIds.join(",")),
        states.map(({ snapshot }) => snapshot.mocked),
        states.map(({ snapshot }) => snapshot.lowAccuracy),
      ]);
    },

    async insertAlerts(tenantId, alerts: readonly AlertWrite[]) {
      if (alerts.length === 0) return [];
      const { rows } = await query(INSERT_ALERTS, [
        tenantId,
        alerts.map((alert) => alert.alertId),
        alerts.map((alert) => alert.vehicleId),
        alerts.map((alert) => alert.type),
        alerts.map((alert) => alert.zoneId),
        alerts.map((alert) => alert.startedAt),
        alerts.map((alert) => alert.raisedAt),
        alerts.map((alert) => alert.resolvedAt),
      ]);
      return rows.map((row) => idRow.parse(row).alert_id);
    },

    async resolveAlerts(tenantId, resolutions) {
      if (resolutions.length === 0) return [];
      const { rows } = await query(RESOLVE_ALERTS, [tenantId, resolutions.map((r) => r.alertId), resolutions.map((r) => r.resolvedAt)]);
      return rows.map((row) => idRow.parse(row).alert_id);
    },

    async readPublishable(tenantId, { vehicleIds, alertsSince }): Promise<PublishableFleet> {
      const stateRows = await query(READ_STATES, [tenantId, vehicleIds]);
      const alertRows = await query(READ_ALERTS, [tenantId, vehicleIds, alertsSince]);
      const states: VehicleState[] = stateRows.rows
        .map((row) => publishableStateRow.parse(row))
        .map((row) => ({
          vehicleId: row.vehicle_id,
          plate: row.plate,
          lon: row.lon,
          lat: row.lat,
          recordedAt: iso(row.recorded_at),
          receivedAt: iso(row.received_at),
          speedMps: row.speed_mps,
          headingDeg: row.heading_deg,
          movement: row.movement,
          stoppedSince: row.stopped_since === null ? null : iso(row.stopped_since),
          zoneIds: row.zone_ids,
          mocked: row.mocked,
          lowAccuracy: row.low_accuracy,
          seq: row.seq,
        }));
      const alerts: Alert[] = alertRows.rows
        .map((row) => publishableAlertRow.parse(row))
        .map((row) => ({
          alertId: row.alert_id,
          vehicleId: row.vehicle_id,
          plate: row.plate,
          type: row.type,
          zoneId: row.zone_id,
          zoneName: row.zone_name,
          startedAt: iso(row.started_at),
          raisedAt: iso(row.raised_at),
          resolvedAt: row.resolved_at === null ? null : iso(row.resolved_at),
          seq: row.seq,
        }));
      return { states, alerts };
    },
  };
}

/**
 * Adaptador de `FleetStateUnitOfWork` sobre Postgres (rol `fleet_app`). `run` toma UNA conexión del pool, abre la transacción, ejecuta el
 * trabajo, confirma o revierte y SIEMPRE libera la conexión (`finally`); si el ROLLBACK mismo falla, la conexión se destruye en vez de volver
 * al pool. Los errores de `pg` se propagan tal cual: el caso de uso y el orquestador los clasifican y nunca los envían fuera del servicio.
 */
export function createPgFleetStateUnitOfWork(pool: FleetStatePool): FleetStateUnitOfWork {
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
