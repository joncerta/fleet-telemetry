/** Conteos de un tenant. Solo números: nunca coordenadas, placas ni tokens (regla 14). */
export interface TenantStats {
  /** Puntos entregados al gateway (cada intento cuenta: un reintento vuelve a contar). */
  sent: number;
  accepted: number;
  rejected: number;
  /** Lotes que no obtuvieron un ACK (red, 429, 5xx, 4xx permanente, ACK ilegible). */
  failedBatches: number;
  /** Puntos que se descartaron sin ACK: un 4xx permanente o el tope de la cola pendiente. */
  dropped: number;
  ackCount: number;
  ackLatencyTotalMs: number;
  ackLatencyMaxMs: number;
}

export interface StatsSummary extends TenantStats {
  tenantId: string;
  ackLatencyAvgMs: number;
}

const empty = (): TenantStats => ({
  sent: 0,
  accepted: 0,
  rejected: 0,
  failedBatches: 0,
  dropped: 0,
  ackCount: 0,
  ackLatencyTotalMs: 0,
  ackLatencyMaxMs: 0,
});

export interface StatsCollector {
  recordAck(tenantId: string, input: { sent: number; accepted: number; rejected: number; latencyMs: number }): void;
  recordFailure(tenantId: string, input: { sent: number; dropped: number }): void;
  recordDropped(tenantId: string, dropped: number): void;
  /** Un resumen por tenant, en orden de `tenantId`. */
  summaries(): StatsSummary[];
}

export function createStatsCollector(): StatsCollector {
  const byTenant = new Map<string, TenantStats>();
  const of = (tenantId: string): TenantStats => {
    const existing = byTenant.get(tenantId);
    if (existing !== undefined) return existing;
    const created = empty();
    byTenant.set(tenantId, created);
    return created;
  };
  return {
    recordAck(tenantId, { sent, accepted, rejected, latencyMs }) {
      const stats = of(tenantId);
      stats.sent += sent;
      stats.accepted += accepted;
      stats.rejected += rejected;
      stats.ackCount += 1;
      stats.ackLatencyTotalMs += latencyMs;
      stats.ackLatencyMaxMs = Math.max(stats.ackLatencyMaxMs, latencyMs);
    },
    recordFailure(tenantId, { sent, dropped }) {
      const stats = of(tenantId);
      stats.sent += sent;
      stats.failedBatches += 1;
      stats.dropped += dropped;
    },
    recordDropped(tenantId, dropped) {
      of(tenantId).dropped += dropped;
    },
    summaries() {
      return [...byTenant]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([tenantId, stats]) => ({
          tenantId,
          ...stats,
          ackLatencyAvgMs: stats.ackCount === 0 ? 0 : Math.round(stats.ackLatencyTotalMs / stats.ackCount),
        }));
    },
  };
}
