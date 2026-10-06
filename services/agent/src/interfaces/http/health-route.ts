import { agentHealthResponseSchema, healthResponseSchema, type AgentHealthResponse } from "@fleet/contracts";
import type { AgentApp } from "./build-app.js";

/**
 * `GET /health`: `200` con todo disponible y `503` con el breaker hacia fleet-api abierto, con el mismo cuerpo
 * (`agentHealthResponseSchema`: solo estados). `GET /health/live`: el proceso responde (no mira dependencias: un orquestador que lo usa
 * para reiniciar no debe reiniciar el agente porque fleet-api esté caído). Ambos sin autenticación y fuera del rate limit.
 */
export function registerHealthRoutes(app: AgentApp, checkHealth: () => AgentHealthResponse): void {
  app.get(
    "/health",
    { config: { rateLimit: false }, schema: { response: { 200: agentHealthResponseSchema, 503: agentHealthResponseSchema } } },
    async (_request, reply) => {
      const health = checkHealth();
      return reply.code(health.status === "ok" ? 200 : 503).send(health);
    },
  );

  app.get("/health/live", { config: { rateLimit: false }, schema: { response: { 200: healthResponseSchema } } }, () => ({
    status: "ok" as const,
    checks: {},
  }));
}
