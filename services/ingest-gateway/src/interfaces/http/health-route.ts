import { healthResponseSchema, type HealthResponse } from "@fleet/contracts";
import type { GatewayApp } from "./build-app.js";

/**
 * `GET /health`: `200` si todas las dependencias responden y `503` si alguna no, con el mismo cuerpo
 * (`healthResponseSchema`: solo estados, ningún dato sensible). Sin autenticación y fuera del rate limit: lo consultan
 * el orquestador y el arnés e2e.
 */
export function registerHealthRoute(app: GatewayApp, checkHealth: () => Promise<HealthResponse>): void {
  app.get(
    "/health",
    {
      config: { rateLimit: false },
      schema: { response: { 200: healthResponseSchema, 503: healthResponseSchema } },
    },
    async (_request, reply) => {
      const health = await checkHealth();
      return reply.code(health.status === "ok" ? 200 : 503).send(health);
    },
  );
}
