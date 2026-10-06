import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ScriptedChatModel } from "./scripted-chat-model.js";

/** Tope de tokens de una respuesta del modelo: las respuestas del agente son cortas. */
const MAX_OUTPUT_TOKENS = 1_024;

export interface ChatModelSettings {
  provider: "anthropic" | "scripted";
  /** Modelo de Anthropic. Con el proveedor con guion no se usa. */
  model: string;
  apiKey?: string | undefined;
}

/** Crea el chat model del agente: Claude real, o el modelo con guion de los tests y el e2e. Se llama una vez, desde el composition root. */
export function createChatModel(settings: ChatModelSettings): BaseChatModel {
  if (settings.provider === "scripted") return new ScriptedChatModel();
  if (settings.apiKey === undefined || settings.apiKey === "") throw new Error("Falta la API key del proveedor del modelo.");
  return new ChatAnthropic({ model: settings.model, apiKey: settings.apiKey, maxTokens: MAX_OUTPUT_TOKENS });
}
