import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { createAgent } from "langchain";
import { AgentFailedError, AgentTimeoutError } from "../application/errors.js";
import type { ChatAgent, ToolCallRecord, UserContext } from "../application/ports.js";

export interface LangChainChatAgentOptions {
  model: BaseChatModel;
  systemPrompt: string;
  /** Pasos (llamada al modelo + herramientas) permitidos por pregunta. */
  maxIterations: number;
  /** Tiempo total de una pregunta, en ms. */
  timeoutMs: number;
  /**
   * Las herramientas de ESTA pregunta: se arman por petición con la sesión del usuario ya inyectada (el LLM nunca la ve) y avisan
   * de cada ejecución con `record`.
   */
  toolsFor: (call: { context: UserContext; record: (call: ToolCallRecord) => void }) => readonly StructuredToolInterface[];
}

/** La pregunta se entrega delimitada como DATO. Se quitan las marcas de cierre que el usuario escriba para que no pueda salirse del bloque. */
export function delimitQuestion(message: string): string {
  return `<pregunta>\n${message.replaceAll(/<\/?pregunta>/gi, "")}\n</pregunta>`;
}

/**
 * Adaptador de `ChatAgent` sobre `createAgent` de LangChain (bucle modelo -> herramientas -> modelo).
 *
 * - El agente se arma por pregunta: sus herramientas llevan la sesión de ESE usuario. Crear el agente es barato; lo que no se
 *   crea por petición es el breaker (vive en el cliente de fleet-api, creado una vez).
 * - Límite de pasos (`recursionLimit`: cada iteración son dos pasos del grafo) y tiempo total (`AbortSignal`).
 * - Cualquier fallo sale como `AgentTimeoutError` o `AgentFailedError`, sin el mensaje original (puede traer la pregunta o claves).
 */
export function createLangChainChatAgent(options: LangChainChatAgentOptions): ChatAgent {
  return {
    async run({ context, message }) {
      const toolCalls: ToolCallRecord[] = [];
      const agent = createAgent({
        model: options.model,
        tools: [...options.toolsFor({ context, record: (call) => toolCalls.push(call) })],
        systemPrompt: options.systemPrompt,
      });
      const signal = AbortSignal.timeout(options.timeoutMs);

      try {
        const result = await agent.invoke(
          { messages: [new HumanMessage(delimitQuestion(message))] },
          { recursionLimit: options.maxIterations * 2 + 1, signal },
        );
        const last = result.messages.at(-1);
        return { answer: last === undefined ? "" : last.text, toolCalls };
      } catch (error) {
        if (signal.aborted) throw new AgentTimeoutError();
        throw new AgentFailedError({ cause: error });
      }
    },
  };
}
