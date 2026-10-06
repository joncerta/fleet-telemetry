import type { ApiError } from "@fleet/contracts";
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from "fastify-type-provider-zod";
import { InvalidCredentialsError, InvalidPairingCodeError, ServerDrainingError, SessionInvalidError, VehicleNotFoundError } from "../../application/errors.js";
import { InvalidCursorError } from "./alert-cursor.js";

export interface MappedError {
  statusCode: number;
  body: ApiError;
  /** Headers de la respuesta. */
  headers?: Record<string, string>;
}

const apiError = (statusCode: number, code: string, message: string): MappedError => ({
  statusCode,
  body: { error: { code, message } },
});

const INVALID_REQUEST = (): MappedError => apiError(400, "invalid_request", "La petición no tiene la estructura esperada.");
const UNAUTHORIZED = (): MappedError => apiError(401, "unauthorized", "Credenciales ausentes o inválidas.");
const NOT_FOUND = (): MappedError => apiError(404, "not_found", "Recurso no encontrado.");
const INTERNAL_ERROR = (): MappedError => apiError(500, "internal_error", "Error interno del servidor.");
const PAYLOAD_TOO_LARGE = (): MappedError => apiError(413, "payload_too_large", "El cuerpo de la petición supera el tamaño máximo permitido.");
const UNSUPPORTED_MEDIA_TYPE = (): MappedError => apiError(415, "unsupported_media_type", "Tipo de contenido no soportado: usa application/json.");

/** Códigos de los errores de Fastify (`FST_ERR_*`) que tienen su propio código de API. */
const FASTIFY_CODES: Readonly<Record<string, () => MappedError>> = {
  FST_ERR_CTP_BODY_TOO_LARGE: PAYLOAD_TOO_LARGE,
  FST_ERR_CTP_INVALID_MEDIA_TYPE: UNSUPPORTED_MEDIA_TYPE,
};

/** Por estado HTTP, para los 4xx que no vienen de un `FST_ERR_*` conocido (p. ej. el 429 de `@fastify/rate-limit`). */
const BY_STATUS: Readonly<Record<number, () => MappedError>> = {
  400: INVALID_REQUEST,
  401: UNAUTHORIZED,
  403: () => apiError(403, "forbidden", "No tienes permiso para esta operación."),
  404: NOT_FOUND,
  413: PAYLOAD_TOO_LARGE,
  415: UNSUPPORTED_MEDIA_TYPE,
  429: () => apiError(429, "rate_limited", "Demasiadas peticiones. Reintenta más tarde."),
};

/** Segundos que se le pide esperar al cliente ante un `503` por apagado: lo que tarda el orquestador en levantar otra tarea. */
export const DRAINING_RETRY_AFTER_SECONDS = 5;

export const notFoundError = (): MappedError => NOT_FOUND();

function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return undefined;
  return typeof error.statusCode === "number" ? error.statusCode : undefined;
}

function codeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

/**
 * Traduce cualquier error a la respuesta de la API (`apiErrorSchema`). Solo usa mensajes fijos: nunca el mensaje del error original,
 * que puede traer SQL, mensajes de `pg`, rutas, el correo o el código de vinculación. El detalle va al log del servidor.
 *
 * - validación de zod (body, params, querystring, headers) -> `400 invalid_request`;
 * - cursor de paginación inválido -> `400 invalid_cursor`;
 * - credenciales inválidas o sesión que ya no vale -> `401 unauthorized` (el mismo, sin distinguir el motivo);
 * - vehículo ajeno o inexistente -> `404 not_found`;
 * - réplica apagándose (sin streams nuevos) -> `503 shutting_down` con `Retry-After`;
 * - código de vinculación inexistente, usado o vencido -> `404 invalid_pairing_code` (el mismo para los tres);
 * - errores de Fastify con código conocido o estado 4xx -> su código de API;
 * - cualquier otra cosa (incluido un fallo al serializar la respuesta o un error de `pg`) -> `500 internal_error`.
 */
export function mapError(error: unknown): MappedError {
  if (hasZodFastifySchemaValidationErrors(error)) return INVALID_REQUEST();
  if (isResponseSerializationError(error)) return INTERNAL_ERROR();
  if (error instanceof InvalidCursorError) return apiError(400, "invalid_cursor", "El cursor de paginación no es válido.");
  if (error instanceof InvalidCredentialsError || error instanceof SessionInvalidError) return UNAUTHORIZED();
  if (error instanceof VehicleNotFoundError) return NOT_FOUND();
  if (error instanceof ServerDrainingError) {
    return { ...apiError(503, "shutting_down", "El servidor se está reiniciando. Reintenta en unos segundos."), headers: { "retry-after": String(DRAINING_RETRY_AFTER_SECONDS) } };
  }
  if (error instanceof InvalidPairingCodeError) return apiError(404, "invalid_pairing_code", "El código no es válido o ya venció.");

  const code = codeOf(error);
  const byCode = code === undefined ? undefined : FASTIFY_CODES[code];
  if (byCode !== undefined) return byCode();

  const status = statusOf(error);
  if (status !== undefined && status >= 400 && status < 500) {
    return (BY_STATUS[status] ?? (() => apiError(status, "bad_request", "Petición inválida.")))();
  }
  return INTERNAL_ERROR();
}
