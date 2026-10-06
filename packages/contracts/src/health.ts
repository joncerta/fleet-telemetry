import { z } from "zod";

/**
 * Respuesta de `GET /health` de los servicios HTTP. Desde v1.
 *
 * `200` cuando todas las dependencias responden y `503` cuando alguna no (misma estructura). Solo estados: nunca
 * versiones, hosts, URLs de conexión, mensajes de error ni datos de negocio.
 *
 * `checks` es un mapa abierto (nombre de la dependencia -> estado) para que cada servicio declare las suyas
 * (`database`, `kafka`...) sin cambiar el contrato.
 */
export const healthResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]).describe("`ok` si todas las dependencias responden; `degraded` si alguna no. Desde v1."),
  checks: z
    .record(z.string().min(1), z.enum(["up", "down"]))
    .describe("Estado de cada dependencia del servicio, por nombre. Desde v1."),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

/**
 * Respuesta de `GET /health/live` (liveness). Aditivo, desde v1.
 *
 * Solo dice que el proceso responde: sin dependencias, así que no hay `checks` ni estado degradado. Lo usan ECS y el ALB
 * para decidir si reiniciar la tarea; la salud de las dependencias (readiness) es `healthResponseSchema` en `/health`.
 */
export const livenessResponseSchema = z.object({
  status: z.literal("ok").describe("Siempre `ok`: si el proceso no responde, no hay respuesta. Desde v1."),
});
export type LivenessResponse = z.infer<typeof livenessResponseSchema>;
