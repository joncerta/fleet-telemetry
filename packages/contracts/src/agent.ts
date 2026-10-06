import { z } from "zod";
import { healthResponseSchema } from "./health.js";

/**
 * Contratos del agente (`services/agent`, fase 1c, todo es v1): el chat en lenguaje natural y la salud del servicio.
 *
 * Variantes. Los enums que pueden crecer (estado del breaker, estado de una herramienta) tienen una variante ESTRICTA (la que
 * serializa el servicio) y una TOLERANTE (`...TolerantSchema`, para la web): un valor que esta versión no conoce se lee como
 * `"unknown"` en vez de fallar. Agregar un valor a un enum rompe a las estrictas (`/add-contract`).
 *
 * Privacidad (Ley 1581): `answer` puede mencionar placas y zonas de la flota. Ni la pregunta ni la respuesta van a logs. El
 * `input` de una herramienta es solo lo que el LLM envió y zod validó (`minMinutes`, `limit`...): nunca la sesión, el tenant ni
 * la cookie, que el servidor inyecta y el LLM no ve.
 */

const UNKNOWN_VALUE = "unknown";

/** Estados de un circuit breaker (los de opossum). */
export const BREAKER_STATES = ["closed", "open", "halfOpen"] as const;
export type BreakerState = (typeof BREAKER_STATES)[number];

export const TOOL_CALL_STATUSES = ["ok", "error"] as const;
export type ToolCallStatus = (typeof TOOL_CALL_STATUSES)[number];

/** Tope de la pregunta, en caracteres. */
export const CHAT_MESSAGE_MAX_LENGTH = 2000;

const strictEnums = {
  breakerState: z.enum(BREAKER_STATES),
  toolStatus: z.enum(TOOL_CALL_STATUSES),
};
const tolerantEnums = {
  breakerState: z.enum([...BREAKER_STATES, UNKNOWN_VALUE]).catch(UNKNOWN_VALUE),
  toolStatus: z.enum([...TOOL_CALL_STATUSES, UNKNOWN_VALUE]).catch(UNKNOWN_VALUE),
};

function agentModel<B extends z.ZodType, S extends z.ZodType>(enums: { breakerState: B; toolStatus: S }) {
  const breaker = z.object({
    state: enums.breakerState.describe("Estado del circuit breaker hacia fleet-api: `closed`, `open` o `halfOpen`. Desde v1."),
  });

  const chatResponse = z.object({
    answer: z.string().describe("Respuesta en español. Solo con datos de las herramientas; si una falló o el breaker está abierto, lo dice. Desde v1."),
    toolCalls: z
      .array(
        z.object({
          name: z.string().min(1).describe("Nombre de la herramienta que ejecutó el agente. Desde v1."),
          input: z
            .record(z.string(), z.json())
            .describe("Argumentos que el LLM envió, ya validados por el esquema de la herramienta. Nunca datos de sesión. Desde v1."),
          status: enums.toolStatus.describe("`ok` o `error` (incluye fleet-api caído con el breaker abierto). Desde v1."),
          durationMs: z.number().int().min(0).describe("Duración de la herramienta en milisegundos. Desde v1."),
        }),
      )
      .describe("Herramientas que usó el agente para responder, en orden. Desde v1."),
    breaker,
  });

  const agentHealthResponse = healthResponseSchema.extend({
    dependencies: z
      .object({
        fleetApi: z.object({
          breaker: enums.breakerState.describe("Estado del circuit breaker hacia fleet-api. Desde v1."),
        }),
        model: z
          .object({
            breaker: enums.breakerState.describe("Estado del circuit breaker hacia el proveedor del modelo. Desde v2 (aditivo, opcional)."),
          })
          .optional()
          .describe("Proveedor del modelo (Anthropic). Opcional: un agente anterior no lo envía. Desde v2 (aditivo, opcional)."),
      })
      .describe("Estado de las dependencias remotas (un breaker por dependencia). Desde v1."),
  });

  return { chatResponse, agentHealthResponse };
}

const strict = agentModel(strictEnums);
const tolerant = agentModel(tolerantEnums);

/** Cuerpo de `POST /v1/chat`. Entrada del servidor, solo ESTRICTA. Desde v1. */
export const chatRequestSchema = z.object({
  message: z.string().min(1).max(CHAT_MESSAGE_MAX_LENGTH).describe("Pregunta del usuario en lenguaje natural (1 a 2000 caracteres). Desde v1."),
});
export type ChatRequest = z.infer<typeof chatRequestSchema>;

/** Respuesta de `POST /v1/chat`. Variante ESTRICTA. Desde v1. */
export const chatResponseSchema = strict.chatResponse;
export type ChatResponse = z.infer<typeof chatResponseSchema>;
/** Igual, TOLERANTE (web): un estado de breaker o de herramienta desconocido se lee como `"unknown"`. Desde v1. */
export const chatResponseTolerantSchema = tolerant.chatResponse;
export type ChatResponseTolerant = z.infer<typeof chatResponseTolerantSchema>;

/**
 * Respuesta de `GET /health` del agente: la de los demás servicios (`healthResponseSchema`) más el estado del breaker de cada
 * dependencia. Variante ESTRICTA. Desde v1.
 */
export const agentHealthResponseSchema = strict.agentHealthResponse;
export type AgentHealthResponse = z.infer<typeof agentHealthResponseSchema>;
/** Igual, TOLERANTE. Desde v1. */
export const agentHealthResponseTolerantSchema = tolerant.agentHealthResponse;
export type AgentHealthResponseTolerant = z.infer<typeof agentHealthResponseTolerantSchema>;
