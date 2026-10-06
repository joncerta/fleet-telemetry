import type { Client } from "pg";
import {
  datasetStart,
  planFleet,
  planZones,
  ringToWkt,
  totalRows,
  VehicleSimulator,
  vehicleDay,
  type FinalVehicleState,
  type FleetPlan,
  type GeneratorConfig,
  type PlannedZone,
  type SyntheticPoint,
} from "./fleet-generator.js";

/** Filas por INSERT: un `unnest` de 14 arreglos de este tamaño. */
const FLUSH_ROWS = 40_000;

// Mismo SQL que `createPgTelemetryRepository` del processor (ver services/processor): un solo INSERT por lote con `unnest`,
// `ST_MakePoint(lon, lat)` (longitud primero), SRID 4326 y `ON CONFLICT (event_id, recorded_at) DO NOTHING`.
export const INSERT_TELEMETRY = `
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

class PointBuffer {
  private cols: unknown[][] = Array.from({ length: 14 }, () => []);

  get size(): number {
    return this.cols[0]?.length ?? 0;
  }

  push(p: SyntheticPoint): void {
    const row = [
      p.eventId, p.tenantId, p.vehicleId, p.deviceId, p.recordedAt.toISOString(), p.receivedAt.toISOString(),
      p.lon, p.lat, p.speedMps, p.headingDeg, p.accuracyM, p.altitudeM, p.mocked, p.lowAccuracy,
    ];
    row.forEach((value, i) => this.cols[i]?.push(value));
  }

  async flush(client: Client): Promise<number> {
    if (this.size === 0) return 0;
    const { rowCount } = await client.query(INSERT_TELEMETRY, this.cols);
    this.cols = Array.from({ length: 14 }, () => []);
    return rowCount ?? 0;
  }
}

export interface LoadedDataset {
  readonly plan: FleetPlan;
  readonly zones: readonly PlannedZone[];
  readonly finals: readonly FinalVehicleState[];
  readonly insertedRows: number;
  readonly elapsedMs: number;
}

export interface LoadOptions {
  readonly config: GeneratorConfig;
  readonly zonesPerTenant: number;
  /** Mensajes de progreso: solo conteos, nunca coordenadas ni identificadores de vehículo (regla 14). */
  readonly log: (message: string) => void;
}

/**
 * Carga tenants, vehículos, telemetría (día a día, cronológica, por lotes), zonas y `vehicle_state` en la base temporal.
 * Los vehículos conservan su estado entre días, así que se recorren en orden.
 */
export async function loadDataset(client: Client, { config, zonesPerTenant, log }: LoadOptions): Promise<LoadedDataset> {
  const started = performance.now();
  const plan = planFleet(config);

  await client.query("INSERT INTO tenants (id, name) SELECT * FROM unnest($1::uuid[], $2::text[])", [
    plan.tenants.map((t) => t.id),
    plan.tenants.map((t) => t.name),
  ]);
  await client.query("INSERT INTO vehicles (id, tenant_id, plate) SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::text[])", [
    plan.vehicles.map((v) => v.id),
    plan.vehicles.map((v) => v.tenantId),
    plan.vehicles.map((v) => v.plate),
  ]);

  const simulators = plan.vehicles.map((v) => new VehicleSimulator(v, config.seed, config.intervalSeconds));
  const buffer = new PointBuffer();
  const expected = totalRows(config);
  let inserted = 0;
  let nextReport = 1_000_000;
  for (let day = 0; day < config.days; day += 1) {
    for (const simulator of simulators) {
      for (const point of vehicleDay(simulator, config, day)) {
        buffer.push(point);
        if (buffer.size >= FLUSH_ROWS) inserted += await buffer.flush(client);
      }
    }
    if (inserted >= nextReport || day === config.days - 1) {
      log(`telemetría: día ${day + 1}/${config.days}, ${inserted} de ~${expected} filas`);
      nextReport = inserted + 1_000_000;
    }
  }
  inserted += await buffer.flush(client);
  log(`telemetría cargada: ${inserted} filas desde ${datasetStart(config).toISOString()}`);

  const finals = simulators.flatMap((s) => {
    const state = s.finalState();
    return state === null ? [] : [state];
  });
  const zones = planZones(config, plan.tenants, finals, zonesPerTenant);
  await insertZones(client, zones);
  await insertVehicleState(client, finals);
  return { plan, zones, finals, insertedRows: inserted, elapsedMs: performance.now() - started };
}

async function insertZones(client: Client, zones: readonly PlannedZone[]): Promise<void> {
  await client.query(
    `INSERT INTO zones (zone_id, tenant_id, name, kind, geom)
     SELECT z.id, z.tenant_id, z.name, z.kind, ST_SetSRID(ST_GeomFromText(z.wkt), 4326)
     FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::text[]) AS z(id, tenant_id, name, kind, wkt)`,
    [zones.map((z) => z.id), zones.map((z) => z.tenantId), zones.map((z) => z.name), zones.map((z) => z.kind), zones.map((z) => ringToWkt(z.ring))],
  );
}

async function insertVehicleState(client: Client, finals: readonly FinalVehicleState[]): Promise<void> {
  await client.query(
    `INSERT INTO vehicle_state (vehicle_id, tenant_id, geom, recorded_at, received_at, speed_mps, heading_deg, movement, stopped_since, mocked, low_accuracy)
     SELECT s.vehicle_id, s.tenant_id, ST_SetSRID(ST_MakePoint(s.lon, s.lat), 4326), s.recorded_at, s.received_at, s.speed_mps, s.heading_deg,
            s.movement, s.stopped_since, s.mocked, s.low_accuracy
     FROM unnest($1::uuid[], $2::uuid[], $3::float8[], $4::float8[], $5::timestamptz[], $6::timestamptz[], $7::float8[], $8::float8[],
                 $9::text[], $10::timestamptz[], $11::boolean[], $12::boolean[])
          AS s(vehicle_id, tenant_id, lon, lat, recorded_at, received_at, speed_mps, heading_deg, movement, stopped_since, mocked, low_accuracy)`,
    [
      finals.map((f) => f.vehicle.id),
      finals.map((f) => f.vehicle.tenantId),
      finals.map((f) => f.point.lon),
      finals.map((f) => f.point.lat),
      finals.map((f) => f.point.recordedAt.toISOString()),
      finals.map((f) => f.point.receivedAt.toISOString()),
      finals.map((f) => f.point.speedMps),
      finals.map((f) => f.point.headingDeg),
      finals.map((f) => f.movement),
      finals.map((f) => f.stoppedSince?.toISOString() ?? null),
      finals.map((f) => f.point.mocked),
      finals.map((f) => f.point.lowAccuracy),
    ],
  );
}
