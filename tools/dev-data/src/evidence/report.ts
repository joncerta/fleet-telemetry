// Utilidades puras de la medición: estadística, lectura de planes EXPLAIN y recorte. Sin I/O.

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("median: sin valores");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/**
 * Chunks de datos que toca un plan: nombres distintos `_hyper_N_M_chunk`. Los `compress_hyper_...` (la tabla comprimida de un
 * chunk) no cuentan aparte: su chunk de datos aparece en el nodo `DecompressChunk`.
 */
export function scannedChunks(plan: readonly string[]): string[] {
  const names = new Set<string>();
  for (const line of plan) {
    for (const match of line.matchAll(/(?<![A-Za-z])_hyper_\d+_\d+_chunk/g)) names.add(match[0]);
  }
  return [...names].sort();
}

/** `Execution Time: 1.234 ms` y `Planning Time: ...` de un plan EXPLAIN ANALYZE, o null si falta. */
export function planTimes(plan: readonly string[]): { executionMs: number; planningMs: number } | null {
  const exec = plan.map((l) => /Execution Time:\s*([\d.]+) ms/.exec(l)).find((m) => m !== null && m !== undefined);
  const planning = plan.map((l) => /Planning Time:\s*([\d.]+) ms/.exec(l)).find((m) => m !== null && m !== undefined);
  if (!exec?.[1]) return null;
  return { executionMs: Number(exec[1]), planningMs: Number(planning?.[1] ?? 0) };
}

/**
 * Recorta un plan a lo relevante: colapsa las líneas repetidas que solo cambian el nombre del chunk (un nodo por chunk) y limita
 * el total. Indica cuántas líneas quitó.
 */
export function trimPlan(plan: readonly string[], maxLines = 40): string[] {
  const out: string[] = [];
  let lastShape: string | null = null;
  let skipped = 0;
  for (const line of plan) {
    const shape = line.replace(/\d+/g, "N").replace(/\(cost=.*$/, "");
    if (shape === lastShape && /_hyper_/.test(line)) {
      skipped += 1;
      continue;
    }
    lastShape = shape;
    out.push(line);
  }
  const limited = out.slice(0, maxLines);
  const removed = skipped + (out.length - limited.length);
  if (removed > 0) limited.push(`[... recortado: ${removed} líneas similares u omitidas]`);
  return limited;
}

export function formatMs(ms: number): string {
  return ms >= 100 ? `${ms.toFixed(0)} ms` : ms >= 10 ? `${ms.toFixed(1)} ms` : `${ms.toFixed(2)} ms`;
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
