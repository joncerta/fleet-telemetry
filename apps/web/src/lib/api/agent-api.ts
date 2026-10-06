import {
  agentHealthResponseTolerantSchema,
  chatRequestSchema,
  chatResponseTolerantSchema,
  type AgentHealthResponseTolerant,
  type ChatResponseTolerant,
} from "@fleet/contracts";
import { UnauthorizedError, type HttpClient } from "./http-client";

/** Rutas del agente (`services/agent/src/interfaces/http`). */
export const AGENT_API_PATHS = { chat: "/v1/chat", health: "/health" } as const;

/** La pregunta no cumple `chatRequestSchema` (vacía o de más de `CHAT_MESSAGE_MAX_LENGTH`): no se envía. */
export class InvalidChatMessageError extends Error {
  constructor() {
    super("La pregunta no es válida.");
    this.name = "InvalidChatMessageError";
  }
}

export interface AgentApi {
  /** `POST /v1/chat` con `{ message }`. Sin historial: cada pregunta es independiente. Cancelable con `signal`. */
  ask(message: string, signal?: AbortSignal): Promise<ChatResponseTolerant>;
  /** `GET /health`: el estado del breaker hacia fleet-api. El `503` (breaker abierto) trae el mismo cuerpo y se lee igual. */
  getHealth(signal?: AbortSignal): Promise<AgentHealthResponseTolerant>;
}

/**
 * Fachada tipada del agente. Misma cookie de sesión que fleet-api (`credentials: "include"`); nunca envía `tenantId` ni identidad: el
 * agente los toma de la sesión. Se lee con las variantes TOLERANTES (un estado de breaker o de herramienta nuevo llega como `unknown`).
 * Un 401 avisa a `onUnauthorized` (lleva al login) y además se lanza.
 */
export function createAgentApi(http: HttpClient, onUnauthorized: () => void): AgentApi {
  return {
    async ask(message, signal) {
      const request = chatRequestSchema.safeParse({ message });
      if (!request.success) throw new InvalidChatMessageError();
      try {
        return await http.request(AGENT_API_PATHS.chat, { method: "POST", body: request.data, schema: chatResponseTolerantSchema, signal });
      } catch (error) {
        if (error instanceof UnauthorizedError) onUnauthorized();
        throw error;
      }
    },
    getHealth: (signal) => http.request(AGENT_API_PATHS.health, { schema: agentHealthResponseTolerantSchema, signal, acceptStatuses: [503] }),
  };
}
