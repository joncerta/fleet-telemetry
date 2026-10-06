import { describe, expect, it } from "vitest";
import { formatBytes, formatMs, median, planTimes, scannedChunks, trimPlan } from "./report.js";

describe("median", () => {
  it("toma el valor central y promedia los dos centrales en un conjunto par", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
  it("falla sin valores", () => {
    expect(() => median([])).toThrow();
  });
});

describe("scannedChunks", () => {
  it("cuenta los chunks de datos distintos y no las tablas comprimidas", () => {
    const plan = [
      "Custom Scan (DecompressChunk) on _hyper_1_3_chunk",
      "  -> Seq Scan on compress_hyper_2_20_chunk",
      "Index Scan using x on _timescaledb_internal._hyper_1_14_chunk",
      "Index Scan using x on _hyper_1_14_chunk",
    ];
    expect(scannedChunks(plan)).toEqual(["_hyper_1_14_chunk", "_hyper_1_3_chunk"]);
  });
});

describe("planTimes", () => {
  it("lee planificación y ejecución", () => {
    expect(planTimes(["Planning Time: 0.350 ms", "Execution Time: 12.5 ms"])).toEqual({ executionMs: 12.5, planningMs: 0.35 });
  });
  it("devuelve null si no es un EXPLAIN ANALYZE", () => {
    expect(planTimes(["Seq Scan on x"])).toBeNull();
  });
});

describe("trimPlan", () => {
  it("colapsa los nodos repetidos por chunk e indica cuántos quitó", () => {
    const plan = Array.from({ length: 10 }, (_, i) => `  -> Index Scan using idx on _hyper_1_${i}_chunk  (cost=0.1..1 rows=1)`);
    const trimmed = trimPlan(["Append", ...plan, "Execution Time: 1 ms"]);

    expect(trimmed.length).toBeLessThan(plan.length);
    expect(trimmed.join("\n")).toMatch(/recortado: 9/);
    expect(trimmed).toContain("Execution Time: 1 ms");
  });
  it("limita el total de líneas", () => {
    const plan = Array.from({ length: 100 }, (_, i) => `Node ${"x".repeat(i)}`);
    expect(trimPlan(plan, 10)).toHaveLength(11);
  });
});

describe("formato", () => {
  it("formatea tiempos y tamaños", () => {
    expect(formatMs(1234.5)).toBe("1235 ms");
    expect(formatMs(0.5)).toBe("0.50 ms");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(10)).toBe("10 B");
  });
});
