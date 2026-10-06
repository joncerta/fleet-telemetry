import type { Client } from "pg";
import { INSERT_TELEMETRY, type LoadedDataset } from "./dataset.js";
import { median, planTimes, scannedChunks, trimPlan } from "./report.js";

/** Repeticiones de cada consulta medida: se informa la primera (caché fría) y la mediana. */
const RUNS = 5;
const DUPLICATE_BATCH = 500;
const IDEMPOTENCY_RUNS = 7;

export interface ExplainResult {
  readonly label: string;
  readonly firstMs: number;
  readonly medianMs: number;
  readonly planningMs: number;
  readonly plan: readonly string[];
  readonly chunksScanned: number;
}

export interface EnvironmentInfo {
  readonly postgres: string;
  readonly timescaledb: string;
  readonly postgis: string;
  readonly sharedBuffers: string;
  readonly workMem: string;
  readonly cpu: string;
  readonly memory: string;
}

export interface DatasetInfo {
  readonly rows: number;
  readonly vehicles: number;
  readonly days: number;
  readonly intervalSeconds: number;
  readonly seed: number;
  readonly zones: number;
  readonly totalChunks: number;
  readonly loadMs: number;
}

export interface CompressionInfo {
  readonly compressedChunks: number;
  readonly compressMs: number;
  readonly beforeTotalBytes: number;
  readonly afterTotalBytes: number;
  /** Solo los chunks comprimidos: antes y después según `chunk_compression_stats`. */
  readonly compressedChunksBeforeBytes: number;
  readonly compressedChunksAfterBytes: number;
  readonly detailedBefore: SizeParts;
  readonly detailedAfter: SizeParts;
}

export interface SizeParts {
  readonly tableBytes: number;
  readonly indexBytes: number;
  readonly toastBytes: number;
  readonly totalBytes: number;
}

export interface IdempotencyResult {
  readonly state: "compressed" | "uncompressed";
  readonly chunkRows: number;
  readonly firstMs: number;
  readonly medianMs: number;
}

export interface SpatialResult {
  readonly natural: ExplainResult;
  readonly usesGist: boolean;
  /** Solo si el plan natural no usa el GIST: el mismo con `enable_seqscan = off`, para mostrar que el índice es utilizable. */
  readonly forced: ExplainResult | null;
  readonly rows: number;
  readonly stoppedVehicles: number;
  readonly criticalZones: number;
}

export interface EvidenceResults {
  readonly measuredAt: string;
  readonly environment: EnvironmentInfo;
  readonly dataset: DatasetInfo;
  readonly cagg: { readonly refreshMs: number; readonly rawPointsInWindow: number; readonly caggPointsInWindow: number };
  readonly chunkExclusion: { readonly recent: ExplainResult; readonly compressed: ExplainResult | null; readonly totalChunks: number };
  readonly compression: CompressionInfo;
  readonly caggVsRaw: { readonly cagg: ExplainResult; readonly raw: ExplainResult; readonly caggRows: number; readonly rawRows: number };
  readonly idempotency: { readonly compressed: IdempotencyResult | null; readonly uncompressed: IdempotencyResult };
  readonly spatial: SpatialResult;
}

const num = (value: unknown): number => Number(value ?? 0);

type Row = Record<string, unknown>;
const query = async (client: Client, sql: string, params: unknown[] = []): Promise<Row[]> => (await client.query<Row>(sql, params)).rows;

async function explain(client: Client, label: string, sql: string, params: unknown[]): Promise<ExplainResult> {
  const times: number[] = [];
  let plan: string[] = [];
  let planning = 0;
  for (let i = 0; i < RUNS; i += 1) {
    const { rows } = await client.query<{ "QUERY PLAN": string }>(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, params);
    plan = rows.map((r) => r["QUERY PLAN"]);
    const parsed = planTimes(plan);
    if (parsed === null) throw new Error(`EXPLAIN sin tiempos: ${label}`);
    times.push(parsed.executionMs);
    planning = parsed.planningMs;
  }
  return {
    label,
    firstMs: times[0] ?? 0,
    medianMs: median(times),
    planningMs: planning,
    plan: trimPlan(plan),
    chunksScanned: scannedChunks(plan).length,
  };
}

async function sizeParts(client: Client): Promise<SizeParts> {
  const rows = await query(client, "SELECT table_bytes::text, index_bytes::text, toast_bytes::text, total_bytes::text FROM hypertable_detailed_size('telemetry')");
  const r: Row = rows[0] ?? {};
  return { tableBytes: num(r.table_bytes), indexBytes: num(r.index_bytes), toastBytes: num(r.toast_bytes), totalBytes: num(r.total_bytes) };
}

async function totalChunkCount(client: Client): Promise<number> {
  const rows = await query(client, "SELECT count(*)::int AS n FROM show_chunks('telemetry')");
  return num(rows[0]?.n);
}

interface ChunkRange {
  readonly start: Date;
  readonly end: Date;
  readonly compressed: boolean;
}

async function chunkRanges(client: Client): Promise<ChunkRange[]> {
  const { rows } = await client.query<{ range_start: Date; range_end: Date; is_compressed: boolean }>(
    "SELECT range_start, range_end, is_compressed FROM timescaledb_information.chunks WHERE hypertable_name = 'telemetry' ORDER BY range_start",
  );
  return rows.map((r) => ({ start: r.range_start, end: r.range_end, compressed: r.is_compressed }));
}

export async function readEnvironment(client: Client): Promise<EnvironmentInfo> {
  const one = async (sql: string): Promise<string> => String((await client.query<{ v: string }>(sql)).rows[0]?.v ?? "desconocido");
  const hostFile = async (path: string): Promise<string | null> => {
    try {
      return String((await client.query<{ v: string }>("SELECT pg_read_file($1) AS v", [path])).rows[0]?.v ?? "");
    } catch {
      return null;
    }
  };
  const cpuInfo = await hostFile("/proc/cpuinfo");
  const memInfo = await hostFile("/proc/meminfo");
  const cpuModel = cpuInfo?.match(/model name\s*:\s*(.+)/)?.[1]?.trim();
  const cpuCount = cpuInfo === null ? 0 : (cpuInfo.match(/^processor\s*:/gm) ?? []).length;
  const memKb = memInfo?.match(/MemTotal:\s*(\d+) kB/)?.[1];
  return {
    postgres: await one("SELECT version() AS v"),
    timescaledb: await one("SELECT extversion AS v FROM pg_extension WHERE extname = 'timescaledb'"),
    postgis: await one("SELECT extversion AS v FROM pg_extension WHERE extname = 'postgis'"),
    sharedBuffers: await one("SHOW shared_buffers"),
    workMem: await one("SHOW work_mem"),
    cpu: cpuModel !== undefined ? `${cpuModel} (${cpuCount} CPU visibles)` : "no disponible (pg_read_file de /proc/cpuinfo falló)",
    memory: memKb !== undefined ? `${(Number(memKb) / 1024 / 1024).toFixed(1)} GiB visibles para el servidor` : "no disponible (pg_read_file de /proc/meminfo falló)",
  };
}

interface MeasureOptions {
  readonly dataset: LoadedDataset;
  readonly seed: number;
  readonly days: number;
  readonly intervalSeconds: number;
  readonly endAt: Date;
  readonly log: (message: string) => void;
}

const HISTORY_SQL = `SELECT event_id, recorded_at, speed_mps, geom FROM telemetry
WHERE tenant_id = $1::uuid AND vehicle_id = $2::uuid AND recorded_at >= $3::timestamptz AND recorded_at < $4::timestamptz
ORDER BY recorded_at DESC LIMIT 500`;

const RAW_HOURLY_SQL = `SELECT vehicle_id, time_bucket('1 hour', recorded_at) AS bucket, count(*) AS points FROM telemetry
WHERE tenant_id = $1::uuid AND recorded_at >= $2::timestamptz AND recorded_at < $3::timestamptz
GROUP BY 1, 2`;

const CAGG_HOURLY_SQL = `SELECT vehicle_id, bucket, points FROM telemetry_hourly
WHERE tenant_id = $1::uuid AND bucket >= $2::timestamptz AND bucket < $3::timestamptz`;

const SPATIAL_SQL = `SELECT vs.vehicle_id, z.zone_id FROM vehicle_state vs
JOIN zones z ON z.tenant_id = vs.tenant_id AND z.kind = 'critical' AND ST_Covers(z.geom, vs.geom)
WHERE vs.tenant_id = $1::uuid AND vs.movement = 'stopped'
LIMIT 500`;

/** Ejecuta las mediciones sobre la base temporal ya cargada. El orden importa: refresco, sin comprimir, compresión, con comprimidos. */
export async function measure(client: Client, { dataset, seed, days, intervalSeconds, endAt, log }: MeasureOptions): Promise<EvidenceResults> {
  const environment = await readEnvironment(client);
  const tenant = dataset.plan.tenants[0];
  const vehicle = dataset.plan.vehicles[0];
  if (tenant === undefined || vehicle === undefined) throw new Error("dataset vacío");

  await client.query("ANALYZE");
  const rows = num((await query(client, "SELECT count(*)::text AS n FROM telemetry"))[0]?.n);

  // 1. Continuous aggregate: refresco completo (la migración lo creó vacío) y verificación contra el conteo directo.
  log("refrescando telemetry_hourly");
  const refreshStart = performance.now();
  await client.query("CALL refresh_continuous_aggregate('telemetry_hourly', NULL, NULL)");
  const refreshMs = performance.now() - refreshStart;
  const windowStart = new Date(endAt.getTime() - 24 * 3_600_000);
  const dayWindow = [tenant.id, windowStart.toISOString(), endAt.toISOString()];
  const rawCount = num((await query(client, "SELECT count(*)::text AS n FROM telemetry WHERE tenant_id = $1::uuid AND recorded_at >= $2::timestamptz AND recorded_at < $3::timestamptz", dayWindow))[0]?.n);
  const caggCount = num((await query(client, "SELECT COALESCE(sum(points), 0)::text AS n FROM telemetry_hourly WHERE tenant_id = $1::uuid AND bucket >= $2::timestamptz AND bucket < $3::timestamptz", dayWindow))[0]?.n);

  // 2. Exclusión de chunks en el historial de un vehículo (2 h), con los datos todavía sin comprimir.
  const totalBeforeCompression = await totalChunkCount(client);
  const recentRange = [tenant.id, vehicle.id, new Date(endAt.getTime() - 3 * 3_600_000).toISOString(), new Date(endAt.getTime() - 1 * 3_600_000).toISOString()];
  log("midiendo exclusión de chunks");
  const recent = await explain(client, "historial de un vehículo, 2 h recientes (chunk sin comprimir)", HISTORY_SQL, recentRange);
  const idempotencyUncompressed = await measureIdempotency(client, tenant.id, vehicle.id, "uncompressed", await pickChunk(client, "uncompressed"));

  // 3. Compresión de los chunks de más de 7 días (lo que haría la política), con el tamaño antes y después.
  log("comprimiendo chunks de más de 7 días");
  const detailedBefore = await sizeParts(client);
  const compressStart = performance.now();
  await client.query("SELECT compress_chunk(c, if_not_compressed => true) FROM show_chunks('telemetry', older_than => INTERVAL '7 days') AS c");
  const compressMs = performance.now() - compressStart;
  await client.query("ANALYZE telemetry");
  const detailedAfter = await sizeParts(client);
  const stats = (
    await query(
      client,
      `SELECT count(*)::int AS chunks, COALESCE(sum(before_compression_total_bytes), 0)::text AS before_bytes, COALESCE(sum(after_compression_total_bytes), 0)::text AS after_bytes
       FROM chunk_compression_stats('telemetry') WHERE compression_status = 'Compressed'`,
    )
  )[0];
  const ranges = await chunkRanges(client);

  // 4. Con chunks comprimidos: historial viejo e idempotencia.
  const compressedChunk = await pickChunk(client, "compressed");
  let compressedHistory: ExplainResult | null = null;
  let idempotencyCompressed: IdempotencyResult | null = null;
  if (compressedChunk !== null) {
    const mid = new Date((compressedChunk.start.getTime() + compressedChunk.end.getTime()) / 2);
    compressedHistory = await explain(client, "historial de un vehículo, 2 h en un chunk comprimido", HISTORY_SQL, [
      tenant.id,
      vehicle.id,
      mid.toISOString(),
      new Date(mid.getTime() + 2 * 3_600_000).toISOString(),
    ]);
    log("midiendo idempotencia sobre un chunk comprimido");
    idempotencyCompressed = await measureIdempotency(client, tenant.id, vehicle.id, "compressed", compressedChunk);
  }

  // 5. Continuous aggregate frente a la consulta cruda ("puntos por vehículo y hora del último día").
  log("midiendo agregado continuo frente a la consulta cruda");
  const caggExplain = await explain(client, "telemetry_hourly (último día)", CAGG_HOURLY_SQL, dayWindow);
  const rawExplain = await explain(client, "agregación directa sobre telemetry (último día)", RAW_HOURLY_SQL, dayWindow);
  const caggRows = num((await query(client, `SELECT count(*)::text AS n FROM (${CAGG_HOURLY_SQL}) q`, dayWindow))[0]?.n);
  const rawRows = num((await query(client, `SELECT count(*)::text AS n FROM (${RAW_HOURLY_SQL}) q`, dayWindow))[0]?.n);

  // 6. Consulta espacial: detenidos dentro de una zona crítica.
  log("midiendo la consulta espacial");
  const spatial = await measureSpatial(client, tenant.id);

  return {
    measuredAt: new Date().toISOString(),
    environment,
    dataset: {
      rows,
      vehicles: dataset.plan.vehicles.length,
      days,
      intervalSeconds,
      seed,
      zones: dataset.zones.length,
      totalChunks: ranges.length || totalBeforeCompression,
      loadMs: dataset.elapsedMs,
    },
    cagg: { refreshMs, rawPointsInWindow: rawCount, caggPointsInWindow: caggCount },
    chunkExclusion: { recent, compressed: compressedHistory, totalChunks: ranges.length || totalBeforeCompression },
    compression: {
      compressedChunks: num(stats?.chunks),
      compressMs,
      beforeTotalBytes: detailedBefore.totalBytes,
      afterTotalBytes: detailedAfter.totalBytes,
      compressedChunksBeforeBytes: num(stats?.before_bytes),
      compressedChunksAfterBytes: num(stats?.after_bytes),
      detailedBefore,
      detailedAfter,
    },
    caggVsRaw: { cagg: caggExplain, raw: rawExplain, caggRows, rawRows },
    idempotency: { compressed: idempotencyCompressed, uncompressed: idempotencyUncompressed },
    spatial,
  };
}

/** Un chunk "del medio" del estado pedido (los extremos del dataset son parciales). Los sin comprimir excluyen el más reciente. */
async function pickChunk(client: Client, state: "compressed" | "uncompressed"): Promise<ChunkRange | null> {
  const all = await chunkRanges(client);
  const pool = state === "compressed" ? all.filter((c) => c.compressed) : all.filter((c) => !c.compressed).slice(0, -1);
  const candidates = pool.length > 0 ? pool : state === "uncompressed" ? all : [];
  return candidates[Math.floor(candidates.length / 2)] ?? null;
}

async function measureIdempotency(
  client: Client,
  tenantId: string,
  vehicleId: string,
  state: "compressed" | "uncompressed",
  chunk: ChunkRange | null,
): Promise<IdempotencyResult> {
  if (chunk === null) throw new Error(`sin chunk ${state} para medir la idempotencia`);
  const { rows } = await client.query(
    `SELECT event_id::text, tenant_id::text, vehicle_id::text, device_id::text, recorded_at::text AS recorded_at, received_at::text AS received_at,
            ST_X(geom) AS lon, ST_Y(geom) AS lat, speed_mps, heading_deg, accuracy_m, altitude_m, mocked, low_accuracy
     FROM telemetry
     WHERE tenant_id = $1::uuid AND vehicle_id = $2::uuid AND recorded_at >= $3::timestamptz AND recorded_at < $4::timestamptz
     ORDER BY recorded_at LIMIT ${DUPLICATE_BATCH}`,
    [tenantId, vehicleId, chunk.start.toISOString(), chunk.end.toISOString()],
  );
  if (rows.length < DUPLICATE_BATCH) throw new Error(`el chunk ${state} tiene solo ${rows.length} puntos del vehículo; hacen falta ${DUPLICATE_BATCH}`);
  const columns = ["event_id", "tenant_id", "vehicle_id", "device_id", "recorded_at", "received_at", "lon", "lat", "speed_mps", "heading_deg", "accuracy_m", "altitude_m", "mocked", "low_accuracy"];
  const params = columns.map((c) => rows.map((r) => (r as Record<string, unknown>)[c] ?? null));

  const times: number[] = [];
  for (let i = 0; i < IDEMPOTENCY_RUNS; i += 1) {
    const started = performance.now();
    const { rowCount } = await client.query(INSERT_TELEMETRY, params);
    times.push(performance.now() - started);
    if (rowCount !== 0) throw new Error(`la inserción de duplicados insertó ${String(rowCount)} filas: la idempotencia falló`);
  }
  const chunkRows = num((await query(client, "SELECT count(*)::text AS n FROM telemetry WHERE recorded_at >= $1::timestamptz AND recorded_at < $2::timestamptz", [chunk.start.toISOString(), chunk.end.toISOString()]))[0]?.n);
  return { state, chunkRows, firstMs: times[0] ?? 0, medianMs: median(times) };
}

async function measureSpatial(client: Client, tenantId: string): Promise<SpatialResult> {
  const natural = await explain(client, "detenidos dentro de una zona crítica", SPATIAL_SQL, [tenantId]);
  const usesGist = natural.plan.some((l) => l.includes("zones_geom_idx"));
  let forced: ExplainResult | null = null;
  if (!usesGist) {
    await client.query("SET enable_seqscan = off");
    try {
      forced = await explain(client, "la misma, con enable_seqscan = off (solo demostración)", SPATIAL_SQL, [tenantId]);
    } finally {
      await client.query("RESET enable_seqscan");
    }
  }
  const rows = num((await query(client, `SELECT count(*)::text AS n FROM (${SPATIAL_SQL}) q`, [tenantId]))[0]?.n);
  const counts = (
    await query(
      client,
      `SELECT (SELECT count(*) FROM vehicle_state WHERE tenant_id = $1::uuid AND movement = 'stopped')::int AS stopped,
              (SELECT count(*) FROM zones WHERE tenant_id = $1::uuid AND kind = 'critical')::int AS critical`,
      [tenantId],
    )
  )[0];
  return { natural, usesGist, forced, rows, stoppedVehicles: num(counts?.stopped), criticalZones: num(counts?.critical) };
}
