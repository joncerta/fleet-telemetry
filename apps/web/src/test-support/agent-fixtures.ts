import type { AgentHealthResponse, ChatResponse } from "@fleet/contracts";

/** Respuesta del agente válida contra `chatResponseSchema` (datos inventados). */
export function chatResponse(overrides: Partial<ChatResponse> = {}): ChatResponse {
  return {
    answer: "Hay 2 vehículos detenidos más de 20 minutos en zonas críticas: NRT101 y NRT102.",
    toolCalls: [{ name: "list_stopped_vehicles", input: { minMinutes: 20, zoneKind: "critical" }, status: "ok", durationMs: 180 }],
    breaker: { state: "closed" },
    ...overrides,
  };
}

export function agentHealth(breaker: AgentHealthResponse["dependencies"]["fleetApi"]["breaker"]): AgentHealthResponse {
  return {
    status: breaker === "open" ? "degraded" : "ok",
    checks: { fleetApi: breaker === "open" ? "down" : "up" },
    dependencies: { fleetApi: { breaker } },
  };
}
