import type { EvidenceResults, ExplainResult, IdempotencyResult } from "./measure.js";
import { formatBytes, formatMs } from "./report.js";

const block = (lines: readonly string[]): string => ["```text", ...lines, "```"].join("\n");

const explainSummary = (e: ExplainResult): string =>
  `primera ${formatMs(e.firstMs)}, mediana de 5: ${formatMs(e.medianMs)} (planificación ${formatMs(e.planningMs)}); chunks escaneados: ${e.chunksScanned}`;

function idempotencyRow(r: IdempotencyResult | null): string {
  if (r === null) return "| comprimido | sin chunks comprimidos en este dataset | | |";
  return `| ${r.state === "compressed" ? "comprimido" : "sin comprimir"} | ${r.chunkRows} | ${formatMs(r.firstMs)} | ${formatMs(r.medianMs)} |`;
}

/** Markdown de `docs/evidence/persistence.md`. Solo cifras, planes recortados y la configuración: ningún dato de un vehículo. */
export function renderReport(r: EvidenceResults, command: string): string {
  const c = r.compression;
  const ratio = (before: number, after: number): string => (after > 0 ? `${(before / after).toFixed(1)}x` : "n/a");
  const { compressed, uncompressed } = r.idempotency;
  const slowdown = compressed !== null && uncompressed.medianMs > 0 ? `${(compressed.medianMs / uncompressed.medianMs).toFixed(0)}x` : "n/a";
  const out: string[] = [];

  out.push("# Evidencia de persistencia (requisito A2, ADR-002)");
  out.push("");
  out.push(`Generado por \`${command}\` el ${r.measuredAt}. Datos sintéticos con semilla ${r.dataset.seed}, en una base temporal con las migraciones reales (se borra al terminar). No edites este archivo a mano: se regenera.`);
  out.push("");
  out.push("## Entorno y dataset");
  out.push("");
  out.push("| | |");
  out.push("|---|---|");
  out.push(`| PostgreSQL | ${r.environment.postgres} |`);
  out.push(`| TimescaleDB | ${r.environment.timescaledb} |`);
  out.push(`| PostGIS | ${r.environment.postgis} |`);
  out.push(`| CPU | ${r.environment.cpu} |`);
  out.push(`| Memoria | ${r.environment.memory} |`);
  out.push(`| shared_buffers / work_mem | ${r.environment.sharedBuffers} / ${r.environment.workMem} |`);
  out.push(`| Filas de telemetría | ${r.dataset.rows.toLocaleString("en-US")} (${r.dataset.vehicles} vehículos x ${r.dataset.days} días x 1 punto cada ${r.dataset.intervalSeconds} s, 2 tenants, Colombia) |`);
  out.push(`| Chunks | ${r.dataset.totalChunks} (intervalo de 1 día) |`);
  out.push(`| Zonas | ${r.dataset.zones} |`);
  out.push(`| Carga | ${formatMs(r.dataset.loadMs)} (INSERT por lotes con unnest, con los índices de la migración 003) |`);
  out.push("");

  out.push("## 1. Exclusión de chunks");
  out.push("");
  out.push("Historial de un vehículo en un rango de 2 horas (`tenant_id`, `vehicle_id` y `recorded_at` con rango, `ORDER BY recorded_at DESC LIMIT 500`).");
  out.push("");
  out.push("| Caso | Chunks escaneados | Chunks totales | Primera | Mediana de 5 |");
  out.push("|---|---|---|---|---|");
  out.push(`| ${r.chunkExclusion.recent.label} | ${r.chunkExclusion.recent.chunksScanned} | ${r.chunkExclusion.totalChunks} | ${formatMs(r.chunkExclusion.recent.firstMs)} | ${formatMs(r.chunkExclusion.recent.medianMs)} |`);
  if (r.chunkExclusion.compressed !== null) {
    const k = r.chunkExclusion.compressed;
    out.push(`| ${k.label} | ${k.chunksScanned} | ${r.chunkExclusion.totalChunks} | ${formatMs(k.firstMs)} | ${formatMs(k.medianMs)} |`);
  }
  out.push("");
  out.push(`EXPLAIN (ANALYZE, BUFFERS), ${r.chunkExclusion.recent.label}:`);
  out.push("");
  out.push(block(r.chunkExclusion.recent.plan));
  if (r.chunkExclusion.compressed !== null) {
    out.push("");
    out.push(`EXPLAIN (ANALYZE, BUFFERS), ${r.chunkExclusion.compressed.label}:`);
    out.push("");
    out.push(block(r.chunkExclusion.compressed.plan));
  }
  out.push("");

  out.push("## 2. Compresión");
  out.push("");
  out.push(`Se comprimieron ${c.compressedChunks} chunks de más de 7 días (lo que haría la política) en ${formatMs(c.compressMs)}. \`segmentby = tenant_id, vehicle_id\`, \`orderby = recorded_at DESC, event_id\`.`);
  out.push("");
  out.push("| Medida | Antes | Después | Razón |");
  out.push("|---|---|---|---|");
  out.push(`| \`hypertable_detailed_size\`, total | ${formatBytes(c.detailedBefore.totalBytes)} | ${formatBytes(c.detailedAfter.totalBytes)} | ${ratio(c.beforeTotalBytes, c.afterTotalBytes)} |`);
  out.push(`| tabla | ${formatBytes(c.detailedBefore.tableBytes)} | ${formatBytes(c.detailedAfter.tableBytes)} | ${ratio(c.detailedBefore.tableBytes, c.detailedAfter.tableBytes)} |`);
  out.push(`| índices | ${formatBytes(c.detailedBefore.indexBytes)} | ${formatBytes(c.detailedAfter.indexBytes)} | ${ratio(c.detailedBefore.indexBytes, c.detailedAfter.indexBytes)} |`);
  out.push(`| toast | ${formatBytes(c.detailedBefore.toastBytes)} | ${formatBytes(c.detailedAfter.toastBytes)} | ${ratio(c.detailedBefore.toastBytes, c.detailedAfter.toastBytes)} |`);
  out.push(`| \`chunk_compression_stats\`, solo chunks comprimidos | ${formatBytes(c.compressedChunksBeforeBytes)} | ${formatBytes(c.compressedChunksAfterBytes)} | ${ratio(c.compressedChunksBeforeBytes, c.compressedChunksAfterBytes)} |`);
  out.push("");

  out.push("## 3. Continuous aggregate frente a la consulta cruda");
  out.push("");
  out.push(`"Puntos por vehículo y hora del último día" de un tenant. Refresco completo inicial de \`telemetry_hourly\`: ${formatMs(r.cagg.refreshMs)}. Puntos de la ventana: ${r.cagg.rawPointsInWindow} (directo) y ${r.cagg.caggPointsInWindow} (suma del agregado): ${r.cagg.rawPointsInWindow === r.cagg.caggPointsInWindow ? "coinciden" : "NO COINCIDEN"}.`);
  out.push("");
  out.push("| Consulta | Filas | Primera | Mediana de 5 | Chunks escaneados |");
  out.push("|---|---|---|---|---|");
  out.push(`| ${r.caggVsRaw.cagg.label} | ${r.caggVsRaw.caggRows} | ${formatMs(r.caggVsRaw.cagg.firstMs)} | ${formatMs(r.caggVsRaw.cagg.medianMs)} | ${r.caggVsRaw.cagg.chunksScanned} |`);
  out.push(`| ${r.caggVsRaw.raw.label} | ${r.caggVsRaw.rawRows} | ${formatMs(r.caggVsRaw.raw.firstMs)} | ${formatMs(r.caggVsRaw.raw.medianMs)} | ${r.caggVsRaw.raw.chunksScanned} |`);
  out.push("");
  out.push(`Aceleración (mediana): ${r.caggVsRaw.cagg.medianMs > 0 ? (r.caggVsRaw.raw.medianMs / r.caggVsRaw.cagg.medianMs).toFixed(1) : "n/a"}x.`);
  out.push("");
  out.push("EXPLAIN del agregado:");
  out.push("");
  out.push(block(r.caggVsRaw.cagg.plan));
  out.push("");
  out.push("EXPLAIN de la consulta cruda:");
  out.push("");
  out.push(block(r.caggVsRaw.raw.plan));
  out.push("");

  out.push("## 4. Idempotencia sobre un chunk comprimido");
  out.push("");
  out.push(`\`INSERT ... ON CONFLICT (event_id, recorded_at) DO NOTHING\` (el SQL del processor) de 500 duplicados consecutivos de un vehículo; las 7 repeticiones son no-op (se verifica que no inserte ninguna fila).`);
  out.push("");
  out.push("| Chunk | Filas del chunk | Primera | Mediana de 7 |");
  out.push("|---|---|---|---|");
  out.push(idempotencyRow(compressed));
  out.push(idempotencyRow(uncompressed));
  out.push("");
  out.push(`Comprimido frente a sin comprimir: ${slowdown} más lento. Medición previa (ADR-004.3, 340 000 filas por chunk): ~170 ms comprimido frente a ~2 ms sin comprimir (~85x). Aquí los chunks tienen ${uncompressed.chunkRows} filas.`);
  out.push("");

  out.push("## 5. Consulta espacial");
  out.push("");
  out.push(`Vehículos detenidos dentro de una zona crítica (\`ST_Covers\` contra \`zones.geom\`, índice GIST \`zones_geom_idx\`). Un tenant: ${r.spatial.stoppedVehicles} vehículos detenidos, ${r.spatial.criticalZones} zonas críticas; devuelve ${r.spatial.rows} filas. ${explainSummary(r.spatial.natural)}.`);
  out.push("");
  out.push(`Plan natural (${r.spatial.usesGist ? "usa" : "NO usa"} \`zones_geom_idx\`):`);
  out.push("");
  out.push(block(r.spatial.natural.plan));
  if (r.spatial.forced !== null) {
    out.push("");
    out.push(`El planificador eligió otro plan con este volumen. Con \`enable_seqscan = off\` (solo demostración; ${explainSummary(r.spatial.forced)}):`);
    out.push("");
    out.push(block(r.spatial.forced.plan));
  }
  out.push("");
  return out.join("\n");
}
