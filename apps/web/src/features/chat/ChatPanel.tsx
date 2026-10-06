import { CHAT_MESSAGE_MAX_LENGTH } from "@fleet/contracts";
import { useId, useState, type FormEvent } from "react";
import type { ChatState } from "./chat-controller";
import { answerText, breakerNoticeOf, durationText, TOOL_STATUS_LABELS, toolInputText, type BreakerNotice, type ToolCallView } from "./chat-view";

const NOTICE_CLASS: Record<BreakerNotice["tone"], string> = {
  ok: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  muted: "bg-canvas text-ink-muted",
};
const TOOL_STATUS_CLASS: Record<ToolCallView["status"], string> = { ok: "text-success", error: "text-danger", unknown: "text-ink-muted" };
const TOOL_STATUS_ICON: Record<ToolCallView["status"], string> = { ok: "✓", error: "✕", unknown: "?" };

/** Herramientas que usó el agente (transparencia): nombre, estado (ícono + texto), duración y argumentos, todo como texto. */
export function ToolCallList({ toolCalls }: { toolCalls: readonly ToolCallView[] }) {
  if (toolCalls.length === 0) return <p className="text-xs text-ink-muted">Sin consultas a la flota.</p>;
  return (
    <ul aria-label="Consultas del asistente" className="space-y-1">
      {toolCalls.map((call, index) => (
        <li key={`${call.name}-${String(index)}`} className="rounded-md bg-canvas px-2 py-1 text-xs">
          <span className="font-mono text-ink">{call.name}</span>{" "}
          <span className={TOOL_STATUS_CLASS[call.status]}>
            <span aria-hidden="true">{TOOL_STATUS_ICON[call.status]}</span> {TOOL_STATUS_LABELS[call.status]}
          </span>{" "}
          <span className="text-ink-muted">· {durationText(call.durationMs)}</span>
          {Object.keys(call.input).length > 0 && <span className="block break-all text-ink-muted">{toolInputText(call.input)}</span>}
        </li>
      ))}
    </ul>
  );
}

export interface ChatPanelProps {
  state: ChatState;
  onAsk: (message: string) => void;
  onRetry: () => void;
  onCancel: () => void;
}

/**
 * Presentación del chat (sin store ni red). La respuesta del agente es NO confiable: se muestra como TEXTO (React la escapa), nunca con
 * `dangerouslySetInnerHTML`. Estados: escribiendo, respuesta, respuesta vacía, error con reintento, límite de uso y breaker abierto.
 */
export function ChatPanel({ state, onAsk, onRetry, onCancel }: ChatPanelProps) {
  const [draft, setDraft] = useState("");
  const inputId = useId();
  const notice = breakerNoticeOf(state.breaker);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (draft.trim() === "") return;
    onAsk(draft);
    setDraft("");
  };

  return (
    <div className="space-y-3">
      {notice !== null && (
        <p role="status" className={`rounded-md px-2 py-1 text-xs font-medium ${NOTICE_CLASS[notice.tone]}`}>
          {notice.text}
        </p>
      )}

      <div aria-live="polite" className="space-y-2">
        {state.question !== null && (
          <p className="rounded-md bg-canvas px-3 py-2 text-ink">
            <span className="sr-only">Tu pregunta: </span>
            {state.question}
          </p>
        )}
        {state.status === "sending" && (
          <div className="flex items-center justify-between gap-2">
            <p role="status" className="text-ink-muted">
              El asistente está pensando…
            </p>
            <button type="button" onClick={onCancel} className="rounded-md border border-line px-2 py-1 text-xs font-medium text-ink hover:bg-canvas">
              Cancelar
            </button>
          </div>
        )}
        {state.status === "answered" && state.response !== null && (
          <div className="space-y-2">
            <p className="whitespace-pre-wrap text-ink">{answerText(state.response)}</p>
            <ToolCallList toolCalls={state.response.toolCalls} />
          </div>
        )}
        {state.status === "failed" && state.failure !== null && (
          <div role="alert" className="space-y-2 rounded-md bg-danger-soft px-3 py-2 text-danger">
            <p>{state.failure.message}</p>
            {state.failure.retryable && (
              <button type="button" onClick={onRetry} className="rounded-md border border-danger px-2 py-1 text-xs font-medium hover:bg-raised">
                Reintentar
              </button>
            )}
          </div>
        )}
      </div>

      <form onSubmit={submit} className="space-y-2" aria-label="Preguntar al asistente">
        <label htmlFor={inputId} className="block font-medium text-ink">
          Tu pregunta
        </label>
        <textarea
          id={inputId}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          maxLength={CHAT_MESSAGE_MAX_LENGTH}
          rows={2}
          placeholder="¿Qué vehículos llevan más de 20 minutos detenidos en zonas críticas?"
          className="block w-full resize-none rounded-md border border-line bg-raised px-3 py-2 text-ink placeholder:text-ink-muted"
        />
        <button
          type="submit"
          disabled={draft.trim() === ""}
          className="w-full rounded-md bg-ink px-4 py-2 font-medium text-raised hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Preguntar
        </button>
      </form>
    </div>
  );
}
