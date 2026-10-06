import type { AgentHealthResponse } from "@fleet/contracts";
import type { BreakerStatus } from "./ports.js";

/**
 * Caso de uso de `GET /health`. fleet-api cuenta como caído solo con el breaker ABIERTO: en `halfOpen` el circuito ya deja pasar
 * una prueba, así que se considera disponible. Con el breaker abierto el estado es `degraded`: el agente sigue vivo (responde que no
 * hay datos), pero el servicio no cumple su función completa.
 */
export function createCheckHealth(deps: { fleetApi: BreakerStatus }): () => AgentHealthResponse {
  return () => {
    const breaker = deps.fleetApi.state();
    const up = breaker !== "open";
    return { status: up ? "ok" : "degraded", checks: { fleetApi: up ? "up" : "down" }, dependencies: { fleetApi: { breaker } } };
  };
}
