import { describe, expect, it } from "vitest";
import { createStatsCollector } from "./stats.js";

describe("createStatsCollector", () => {
  it("acumula por tenant, con latencia media y máxima, ordenado por tenant", () => {
    const stats = createStatsCollector();
    stats.recordAck("b", { sent: 3, accepted: 3, rejected: 0, latencyMs: 20 });
    stats.recordAck("a", { sent: 2, accepted: 1, rejected: 1, latencyMs: 10 });
    stats.recordAck("a", { sent: 3, accepted: 3, rejected: 0, latencyMs: 50 });
    stats.recordFailure("a", { sent: 3, dropped: 0 });

    expect(stats.summaries()).toEqual([
      expect.objectContaining({ tenantId: "a", sent: 8, accepted: 4, rejected: 1, failedBatches: 1, ackLatencyAvgMs: 30, ackLatencyMaxMs: 50 }),
      expect.objectContaining({ tenantId: "b", sent: 3, accepted: 3, ackLatencyAvgMs: 20 }),
    ]);
  });

  it("sin ACK la latencia media es 0, y el resumen solo tiene números y el tenant", () => {
    const stats = createStatsCollector();
    stats.recordFailure("a", { sent: 1, dropped: 1 });
    stats.recordDropped("a", 2);

    const [summary] = stats.summaries();
    expect(summary).toMatchObject({ ackLatencyAvgMs: 0, dropped: 3 });
    expect(Object.values(summary ?? {}).every((value) => typeof value === "number" || value === "a")).toBe(true);
  });
});
