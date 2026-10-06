import { CHAT_MESSAGE_MAX_LENGTH } from "@fleet/contracts";
import { InvalidChatMessageError } from "../../lib/api/agent-api";
import { ApiRequestError, InvalidResponseError, NetworkError, UnauthorizedError } from "../../lib/api/http-client";

export interface ChatFailure {
  readonly message: string;
  /** Se ofrece "Reintentar" con la misma pregunta (no tiene sentido tras una pregunta inválida o sin sesión). */
  readonly retryable: boolean;
  /** Es el límite de preguntas por usuario (429). */
  readonly rateLimited: boolean;
}

const failure = (message: string, retryable = true, rateLimited = false): ChatFailure => ({ message, retryable, rateLimited });

/** Espera de un `Retry-After` en palabras: "30 s", "2 min". */
function waitOf(seconds: number): string {
  return seconds < 60 ? `${Math.max(1, Math.ceil(seconds))} s` : `${Math.ceil(seconds / 60)} min`;
}

/**
 * Mensaje para el usuario por una pregunta fallida (errores del agente con `apiErrorSchema`). Nunca muestra el mensaje técnico del
 * servidor ni la pregunta.
 */
export function chatFailureOf(error: unknown): ChatFailure {
  if (error instanceof InvalidChatMessageError) return failure(`Escribe una pregunta de 1 a ${CHAT_MESSAGE_MAX_LENGTH} caracteres.`, false);
  if (error instanceof UnauthorizedError) return failure("Tu sesión venció. Vuelve a ingresar.", false);
  if (error instanceof NetworkError) return failure("No se pudo conectar con el asistente. Revisa tu conexión e inténtalo de nuevo.");
  if (error instanceof InvalidResponseError) return failure("La respuesta del asistente no tiene el formato esperado. Inténtalo de nuevo.");
  if (error instanceof ApiRequestError) {
    if (error.status === 429) {
      const wait = error.retryAfterSeconds === null ? "unos minutos" : waitOf(error.retryAfterSeconds);
      return failure(`Alcanzaste el límite de preguntas. Inténtalo de nuevo en ${wait}.`, true, true);
    }
    if (error.code === "agent_timeout" || error.status === 504) return failure("El asistente tardó demasiado en responder. Inténtalo de nuevo.");
    if (error.code === "agent_unavailable" || error.status === 503) return failure("El asistente no está disponible en este momento. Inténtalo de nuevo.");
    if (error.status === 400 || error.status === 413) return failure(`Escribe una pregunta de 1 a ${CHAT_MESSAGE_MAX_LENGTH} caracteres.`, false);
  }
  return failure("No se pudo obtener una respuesta. Inténtalo de nuevo.");
}
