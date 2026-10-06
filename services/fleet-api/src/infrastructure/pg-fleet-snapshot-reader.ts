import { alertSchema, vehicleStateSchema, ALERT_TYPES, MOVEMENTS } from "@fleet/contracts";
import { z } from "zod";
import type { FleetSnapshotData, FleetSnapshotReader } from "../application/ports.js";

/** Lo único que hace falta del pool de `pg`: un cliente propio para toda la transacción. */
export interface SnapshotClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  /** `true` descarta la conexión (si quedó en un estado dudoso) en vez de devolverla al pool. */
  release(discard?: boolean): void;
}
export interface SnapshotPool {
  connect(): Promise<SnapshotClient>;
}

/** Topes del snapshot (todo listado lleva LIMIT). Pasarlos es un error, no un truncado: el cliente creería que ese es todo el estado. */
export const MAX_SNAPSHOT_VEHICLES = 5_000;
export const MAX_SNAPSHOT_ALERTS = 2_000;

/** El tenant tiene más vehículos o alertas activas que un snapshot admite. Sube como 500: es un caso nuevo, no algo para recortar. */
export class SnapshotTooLargeError extends Error {
  constructor(what: "vehicles" | "alerts", limit: number) {
    super(`El tenant supera el máximo de ${limit} ${what} de un snapshot.`);
    this.name = "SnapshotTooLargeError";
  }
}

// Una transacción REPEATABLE READ de solo lectura: las dos consultas ven el MISMO instante de la base, así el `cursor` (máximo seq) describe
// exactamente lo que el cliente recibe. Toda sentencia está parametrizada, filtra por `tenant_id` (en la tabla principal y en cada JOIN) y lleva
// LIMIT; ninguna toca la hypertable de telemetría. `bigint` sale como texto (`::text`) y se convierte explícitamente; la posición con
// ST_X (longitud) y ST_Y (latitud).
const BEGIN = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY";

const FIND_VEHICLES = `
SELECT s.vehicle_id, v.plate, ST_X(s.geom) AS lon, ST_Y(s.geom) AS lat, s.recorded_at, s.received_at, s.speed_mps, s.heading_deg,
       s.movement, s.stopped_since, s.zone_ids::text[] AS zone_ids, s.mocked, s.low_accuracy, s.seq::text AS seq
  FROM vehicle_state s
  JOIN vehicles v ON v.id = s.vehicle_id AND v.tenant_id = s.tenant_id
 WHERE s.tenant_id = $1
 ORDER BY s.vehicle_id
 LIMIT $2`;

const FIND_ACTIVE_ALERTS = `
SELECT a.alert_id, a.vehicle_id, v.plate, a.type, a.zone_id, z.name AS zone_name, a.started_at, a.raised_at, a.resolved_at, a.seq::text AS seq
  FROM alerts a
  JOIN vehicles v ON v.id = a.vehicle_id AND v.tenant_id = a.tenant_id
  LEFT JOIN zones z ON z.zone_id = a.zone_id AND z.tenant_id = a.tenant_id
 WHERE a.tenant_id = $1 AND a.resolved_at IS NULL
 ORDER BY a.raised_at DESC, a.alert_id DESC
 LIMIT $2`;

const vehicleRow = z.object({
  vehicle_id: z.uuid(),
  plate: z.string(),
  lon: z.number(),
  lat: z.number(),
  recorded_at: z.date(),
  received_at: z.date(),
  speed_mps: z.number().nullable(),
  heading_deg: z.number().nullable(),
  movement: z.enum(MOVEMENTS),
  stopped_since: z.date().nullable(),
  zone_ids: z.array(z.uuid()),
  mocked: z.boolean(),
  low_accuracy: z.boolean(),
  seq: z.string(),
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
});

/**
 * Lector del snapshot del stream sobre Postgres (rol `fleet_app`, solo SELECT). Cada fila se valida contra el esquema ESTRICTO del contrato:
 * un dato inválido en la base falla aquí, no en el cliente. Los errores de `pg` se propagan; nunca llegan al cliente. Placa y posición son
 * datos personales: no se registran.
 */
export function createPgFleetSnapshotReader(pool: SnapshotPool): FleetSnapshotReader {
  return {
    async read(tenantId): Promise<FleetSnapshotData> {
      const client = await pool.connect();
      let discard = false;
      try {
        await client.query(BEGIN);
        // `limit + 1`: una fila de más prueba que el tenant se pasó del tope.
        const vehicles = await client.query(FIND_VEHICLES, [tenantId, MAX_SNAPSHOT_VEHICLES + 1]);
        const alerts = await client.query(FIND_ACTIVE_ALERTS, [tenantId, MAX_SNAPSHOT_ALERTS + 1]);
        await client.query("COMMIT");

        if (vehicles.rows.length > MAX_SNAPSHOT_VEHICLES) throw new SnapshotTooLargeError("vehicles", MAX_SNAPSHOT_VEHICLES);
        if (alerts.rows.length > MAX_SNAPSHOT_ALERTS) throw new SnapshotTooLargeError("alerts", MAX_SNAPSHOT_ALERTS);

        return {
          vehicles: vehicles.rows.map((raw) => {
            const row = vehicleRow.parse(raw);
            return vehicleStateSchema.parse({
              vehicleId: row.vehicle_id,
              plate: row.plate,
              lon: row.lon,
              lat: row.lat,
              recordedAt: row.recorded_at.toISOString(),
              receivedAt: row.received_at.toISOString(),
              speedMps: row.speed_mps,
              headingDeg: row.heading_deg,
              movement: row.movement,
              stoppedSince: row.stopped_since === null ? null : row.stopped_since.toISOString(),
              zoneIds: row.zone_ids,
              mocked: row.mocked,
              lowAccuracy: row.low_accuracy,
              seq: row.seq,
            });
          }),
          alerts: alerts.rows.map((raw) => {
            const row = alertRow.parse(raw);
            return alertSchema.parse({
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
            });
          }),
        };
      } catch (err) {
        // Sin ROLLBACK la conexión volvería al pool dentro de una transacción abortada; si ni eso se puede, se descarta.
        await client.query("ROLLBACK").catch(() => {
          discard = true;
        });
        throw err;
      } finally {
        client.release(discard);
      }
    },
  };
}
