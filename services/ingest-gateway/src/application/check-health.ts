import type { HealthResponse } from "@fleet/contracts";
import type { ReadinessCheck } from "./ports.js";

/**
 * Caso de uso de `GET /health`: consulta todas las dependencias en paralelo. `ok` solo si todas responden; si una
 * lanza (un adaptador no debería, pero no se confía) cuenta como caída, y nunca se propaga su mensaje.
 */
export function createCheckHealth(checks: readonly ReadinessCheck[]): () => Promise<HealthResponse> {
  return async () => {
    const results = await Promise.all(checks.map(async (probe) => [probe.name, await Promise.resolve().then(() => probe.check()).catch(() => false)] as const));
    const states = Object.fromEntries(results.map(([name, up]) => [name, up ? "up" : "down"] as const));
    return { status: results.every(([, up]) => up) ? "ok" : "degraded", checks: states };
  };
}
