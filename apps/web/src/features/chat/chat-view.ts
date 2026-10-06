import type { ChatResponseTolerant } from "@fleet/contracts";
import type { BreakerStateView } from "./chat-controller";

export type ToolCallView = ChatResponseTolerant["toolCalls"][number];

export interface BreakerNotice {
  readonly tone: "ok" | "warning" | "danger" | "muted";
  readonly text: string;
}

/** Aviso del estado del breaker del agente hacia fleet-api. Con `open`, los datos de la flota NO están disponibles: se dice. */
export function breakerNoticeOf(state: BreakerStateView | null): BreakerNotice | null {
  switch (state) {
    case null:
      return null;
    case "closed":
      return { tone: "ok", text: "Datos de la flota disponibles." };
    case "halfOpen":
      return { tone: "warning", text: "Recuperando la conexión con los datos de la flota…" };
    case "open":
      return { tone: "danger", text: "Datos de la flota no disponibles: el asistente no puede consultarlos en este momento." };
    default:
      return { tone: "muted", text: "Estado de los datos de la flota desconocido." };
  }
}

export const TOOL_STATUS_LABELS: Record<ToolCallView["status"], string> = {
  ok: "correcta",
  error: "falló",
  unknown: "estado desconocido",
};

const MAX_INPUT_TEXT = 120;

/** Argumentos de una herramienta como texto corto (`minMinutes: 20, zoneKind: "critical"`). Solo texto: nunca se interpreta como HTML. */
export function toolInputText(input: ToolCallView["input"]): string {
  const text = Object.entries(input)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join(", ");
  return text.length > MAX_INPUT_TEXT ? `${text.slice(0, MAX_INPUT_TEXT - 1)}…` : text;
}

/** Duración legible de una herramienta: "180 ms", "2,4 s". */
export function durationText(ms: number): string {
  return ms < 1_000 ? `${ms} ms` : `${(ms / 1_000).toLocaleString("es-CO", { maximumFractionDigits: 1 })} s`;
}

/** La respuesta a mostrar; una vacía se dice como vacía (nunca un globo en blanco). */
export function answerText(response: ChatResponseTolerant): string {
  return response.answer.trim() === "" ? "El asistente no devolvió una respuesta." : response.answer;
}
