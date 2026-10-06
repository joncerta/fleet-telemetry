import { healthResponseSchema, livenessResponseSchema, type HealthResponse } from "@fleet/contracts";
import type { GatewayApp } from "./build-app.js";

/**
 * `GET /health`: `200` si todas las dependencias responden y `503` si alguna no, con el mismo cuerpo
 * (`healthResponseSchema`: solo estados, ningún dato sensible). Sin autenticación y fuera del rate limit: lo consultan
 * compose y el arnés e2e (readiness).
 *
 * `GET /health/live` (liveness, para ECS y el ALB): `200 { status: "ok" }` mientras el event loop responda. No toca la base ni
 * Kafka y no cuenta en el rate limit: un corte de una dependencia no debe hacer que se reinicien todas las tareas a la vez
 * (ver ADR-008).
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
  app.get(
    "/health/live",
    {
      config: { rateLimit: false },
      schema: { response: { 200: livenessResponseSchema } },
    },
    () => ({ status: "ok" as const }),
  );
}
