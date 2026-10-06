import type { ChatResponseTolerant } from "@fleet/contracts";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { AgentApi } from "../../lib/api/agent-api";
import { chatFailureOf, isAgentUnreachable, type ChatFailure } from "./chat-errors";

export type BreakerStateView = ChatResponseTolerant["breaker"]["state"];

export interface ChatState {
  /** `sending`: esperando al agente ("escribiendo"). */
  readonly status: "idle" | "sending" | "answered" | "failed";
  /** La ÚLTIMA pregunta enviada: sin historial (cada pregunta es independiente en el agente). */
  readonly question: string | null;
  readonly response: ChatResponseTolerant | null;
  readonly failure: ChatFailure | null;
  /** Breaker del agente hacia fleet-api, de la última respuesta o de `/health`. `null` mientras no se sabe. */
  readonly breaker: BreakerStateView | null;
}

export interface ChatController {
  readonly store: StoreApi<ChatState>;
  /** Envía la pregunta. Si había otra en curso, la cancela (solo vale la última). */
  ask(message: string): Promise<void>;
  /** Repite la última pregunta, si el fallo lo permite. */
  retry(): Promise<void>;
  /** Cancela la pregunta en curso (al cerrar el chat). */
  cancel(): void;
  /** Consulta el breaker en `/health` (al abrir el chat). Un fallo aquí no es un error del chat: el breaker pasa a `unknown` ("desconocido"), nunca conserva el último. */
  refreshHealth(): Promise<void>;
  /** Cancela todo lo pendiente (al desmontar). */
  dispose(): void;
}

const INITIAL: ChatState = { status: "idle", question: null, response: null, failure: null, breaker: null };

const isAbort = (error: unknown): boolean => error instanceof DOMException && error.name === "AbortError";

/**
 * Estado y orquestación del chat con el agente, sin React: así se prueba con un `fetch` falso. La respuesta del agente es NO confiable
 * (puede traer HTML o markdown inyectado desde los datos): el controlador la guarda tal cual y la UI la muestra como texto.
 */
export function createChatController(api: Pick<AgentApi, "ask" | "getHealth">): ChatController {
  const store = createStore<ChatState>()(() => INITIAL);
  let current: AbortController | null = null;
  let health: AbortController | null = null;

  const abortCurrent = () => {
    current?.abort();
    current = null;
  };

  const ask = async (message: string) => {
    abortCurrent();
    const request = new AbortController();
    current = request;
    const question = message.trim();
    store.setState({ status: "sending", question, response: null, failure: null });
    try {
      const response = await api.ask(question, request.signal);
      if (current !== request) return;
      store.setState({ status: "answered", response, breaker: response.breaker.state });
    } catch (error) {
      // Cancelada (otra pregunta, cerrar el chat, desmontar): no es un fallo que mostrar.
      if (current !== request || isAbort(error)) return;
      // Si el agente no respondió, no se conserva el estado anterior del breaker: ya no se sabe.
      store.setState({ status: "failed", failure: chatFailureOf(error), ...(isAgentUnreachable(error) && { breaker: "unknown" as const }) });
    } finally {
      if (current === request) current = null;
    }
  };

  return {
    store,
    ask,
    async retry() {
      const { status, failure, question } = store.getState();
      if (status !== "failed" || failure?.retryable !== true || question === null) return;
      await ask(question);
    },
    cancel() {
      if (current === null) return;
      abortCurrent();
      if (store.getState().status === "sending") store.setState({ status: "idle", question: null });
    },
    async refreshHealth() {
      health?.abort();
      const request = new AbortController();
      health = request;
      try {
        const result = await api.getHealth(request.signal);
        if (health === request) store.setState({ breaker: result.dependencies.fleetApi.breaker });
      } catch (error) {
        // Cancelada (otra consulta o cerrar el chat): no dice nada del agente. Sin respuesta de /health: el último estado ya no es de fiar.
        if (health === request && !isAbort(error)) store.setState({ breaker: "unknown" });
      } finally {
        if (health === request) health = null;
      }
    },
    dispose() {
      abortCurrent();
      health?.abort();
      health = null;
    },
  };
}
