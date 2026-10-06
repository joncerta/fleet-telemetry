import type { Logger } from "@fleet/platform";
import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { MODEL_MAX_RETRIES, modelCallDeadlineMs } from "../domain/model-limits.js";
import { createGuardedChatModel, type GuardedChatModel } from "./guarded-chat-model.js";
import type { BreakerSettings } from "./resilient-fleet-client.js";
import { ScriptedChatModel } from "./scripted-chat-model.js";

/** Tope de tokens de una respuesta del modelo: las respuestas del agente son cortas. */
const MAX_OUTPUT_TOKENS = 1_024;

const WORKSPACE_HEADER = "anthropic-workspace-id";

export interface ChatModelSettings {
  provider: "anthropic" | "scripted";
  /** Modelo de Anthropic. Con el proveedor con guion no se usa. */
  model: string;
  apiKey?: string | undefined;
  /** Workspace de Anthropic: se envía en `anthropic-workspace-id`. Solo hace falta si la API key no está ligada a un workspace. */
  workspaceId?: string | undefined;
  /** Tiempo máximo de UNA petición al proveedor, en ms. */
  callTimeoutMs: number;
  /**
   * Peticiones simultáneas al proveedor desde esta réplica. Los cupos los lleva el guardián, FUERA del breaker; el `AsyncCaller` de LangChain
   * no los limita (su cola contaría para el deadline y su espera de reintento no la acota nadie).
   */
  maxConcurrency: number;
  /** Umbrales del breaker del proveedor. El deadline de la llamada se deriva de `callTimeoutMs` y los reintentos (`modelCallDeadlineMs`). */
  breaker: Omit<BreakerSettings, "timeoutMs">;
  logger?: Logger;
  /** `fetch` inyectable, para los tests. */
  fetch?: typeof fetch;
}

/** El modelo SIN breaker: Claude real (con reintentos, concurrencia y timeout acotados), o el modelo con guion de los tests y el e2e. */
export function createProviderModel(settings: ChatModelSettings): BaseChatModel {
  if (settings.provider === "scripted") return new ScriptedChatModel();
  if (settings.apiKey === undefined || settings.apiKey === "") throw new Error("Falta la API key del proveedor del modelo.");
  return new ChatAnthropic({
    model: settings.model,
    apiKey: settings.apiKey,
    maxTokens: MAX_OUTPUT_TOKENS,
    maxRetries: MODEL_MAX_RETRIES,
    clientOptions: {
      timeout: settings.callTimeoutMs,
      ...(settings.fetch !== undefined && { fetch: settings.fetch }),
      ...(settings.workspaceId !== undefined && settings.workspaceId !== "" && { defaultHeaders: { [WORKSPACE_HEADER]: settings.workspaceId } }),
    },
  });
}

/**
 * Crea el chat model del agente detrás de su circuit breaker. Se llama UNA vez, desde el composition root: el breaker es de la
 * dependencia (el proveedor del modelo), no de la pregunta. Con el proveedor con guion también se aplica, para que el e2e recorra el
 * mismo camino que producción.
 */
export function createChatModel(settings: ChatModelSettings): GuardedChatModel {
  return createGuardedChatModel({
    model: createProviderModel(settings),
    breaker: { ...settings.breaker, timeoutMs: modelCallDeadlineMs(settings.callTimeoutMs) },
    maxConcurrency: settings.maxConcurrency,
    ...(settings.logger !== undefined && { logger: settings.logger }),
  });
}
