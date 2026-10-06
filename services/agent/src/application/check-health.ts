import type { AgentHealthResponse } from "@fleet/contracts";
import type { BreakerStatus } from "./ports.js";

/**
 * Caso de uso de `GET /health`. Una dependencia (fleet-api, el proveedor del modelo) cuenta como caída solo con su breaker ABIERTO: en
 * `halfOpen` el circuito ya deja pasar una prueba, así que se considera disponible. Con alguno abierto el estado es `degraded`: el
 * agente sigue vivo, pero no cumple su función completa (sin fleet-api no hay datos; sin el modelo, el chat responde 503).
 */
export function createCheckHealth(deps: { fleetApi: BreakerStatus; model: BreakerStatus }): () => AgentHealthResponse {
  return () => {
    const fleetApi = deps.fleetApi.state();
    const model = deps.model.state();
    const fleetApiUp = fleetApi !== "open";
    const modelUp = model !== "open";
    return {
      status: fleetApiUp && modelUp ? "ok" : "degraded",
      checks: { fleetApi: fleetApiUp ? "up" : "down", model: modelUp ? "up" : "down" },
      dependencies: { fleetApi: { breaker: fleetApi }, model: { breaker: model } },
    };
  };
}
