import type { ChatResponse } from "@fleet/contracts";
import type { BreakerStatus, ChatAgent, UserContext } from "./ports.js";

/** `signal` se aborta cuando el cliente cierra la conexión: la corrida se cancela. */
export type Chat = (input: { context: UserContext; message: string; signal?: AbortSignal | undefined }) => Promise<ChatResponse>;

/** Respuesta cuando el modelo no produce texto: el usuario nunca recibe una respuesta vacía. */
export const EMPTY_ANSWER = "No pude generar una respuesta para esa pregunta. Intenta reformularla.";

/**
 * Responde una pregunta en lenguaje natural. El agente (modelo + herramientas) decide qué consultar; aquí se arma la respuesta del
 * contrato con las herramientas que usó y el estado del breaker hacia fleet-api, que la web muestra tal cual.
 *
 * Los errores del agente (`AgentTimeoutError`, `AgentFailedError`) suben sin cambios: la entrada HTTP los traduce.
 */
export function createChat(deps: { agent: ChatAgent; breaker: BreakerStatus }): Chat {
  return async ({ context, message, signal }) => {
    const run = await deps.agent.run({ context, message, signal });
    const answer = run.answer.trim();
    return {
      answer: answer === "" ? EMPTY_ANSWER : answer,
      toolCalls: [...run.toolCalls],
      // Se lee DESPUÉS de correr el agente: refleja lo que acaban de ver sus herramientas.
      breaker: { state: deps.breaker.state() },
    };
  };
}
