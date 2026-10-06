import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { createAgent } from "langchain";
import { AgentCancelledError, AgentFailedError, AgentTimeoutError } from "../application/errors.js";
import type { ChatAgent, ToolCallRecord, UserContext } from "../application/ports.js";
import { describeProviderError } from "./provider-error.js";

/** Tokens que consumió una pregunta, sumados sobre todas las llamadas al modelo. Solo cifras: nunca el texto. */
export interface ModelUsage {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface LangChainChatAgentOptions {
  model: BaseChatModel;
  systemPrompt: string;
  /** Pasos (llamada al modelo + herramientas) permitidos por pregunta. */
  maxIterations: number;
  /** Tiempo total de una pregunta, en ms. */
  timeoutMs: number;
  /** Nombre del modelo, para el reporte de uso. */
  modelName: string;
  /** Se llama una vez por pregunta respondida con el uso del modelo, para registrarlo con el tenant. */
  onUsage?: (usage: ModelUsage, context: UserContext) => void;
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

/** Suma los tokens de entrada y salida de todas las respuestas del modelo (`AIMessage.usage_metadata`) de una corrida. */
export function sumUsage(messages: readonly unknown[]): { inputTokens: number; outputTokens: number } {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const message of messages) {
    if (!AIMessage.isInstance(message) || message.usage_metadata === undefined) continue;
    inputTokens += message.usage_metadata.input_tokens;
    outputTokens += message.usage_metadata.output_tokens;
  }
  return { inputTokens, outputTokens };
}

/**
 * Adaptador de `ChatAgent` sobre `createAgent` de LangChain (bucle modelo -> herramientas -> modelo).
 *
 * - El agente se arma por pregunta: sus herramientas llevan la sesión de ESE usuario. Crear el agente es barato; lo que no se
 *   crea por petición es el breaker (vive en el cliente de fleet-api, creado una vez).
 * - Límite de pasos (`recursionLimit`: cada iteración son dos pasos del grafo) y tiempo total. El `signal` de la corrida combina ese
 *   tiempo con el del llamador (el cierre del cliente): si el usuario cierra la pestaña, la corrida se cancela.
 * - Suma `usage_metadata` de las respuestas del modelo (costo) y lo entrega a `onUsage`.
 * - Cualquier fallo sale como `AgentTimeoutError`, `AgentCancelledError` o `AgentFailedError`, sin el mensaje original (puede traer la pregunta o claves).
 */
export function createLangChainChatAgent(options: LangChainChatAgentOptions): ChatAgent {
  return {
    async run({ context, message, signal: callerSignal }) {
      const toolCalls: ToolCallRecord[] = [];
      const agent = createAgent({
        model: options.model,
        tools: [...options.toolsFor({ context, record: (call) => toolCalls.push(call) })],
        systemPrompt: options.systemPrompt,
      });
      const timeout = AbortSignal.timeout(options.timeoutMs);
      const signal = callerSignal === undefined ? timeout : AbortSignal.any([timeout, callerSignal]);

      try {
        const result = await agent.invoke(
          { messages: [new HumanMessage(delimitQuestion(message))] },
          { recursionLimit: options.maxIterations * 2 + 1, signal },
        );
        options.onUsage?.({ model: options.modelName, ...sumUsage(result.messages) }, context);
        const last = result.messages.at(-1);
        return { answer: last === undefined ? "" : last.text, toolCalls };
      } catch (error) {
        // El tiempo total manda sobre la cancelación: si ambos ocurrieron, la pregunta venció.
        if (timeout.aborted) throw new AgentTimeoutError();
        if (callerSignal?.aborted === true) throw new AgentCancelledError();
        throw new AgentFailedError({ cause: error, failure: describeProviderError(error) });
      }
    },
  };
}
