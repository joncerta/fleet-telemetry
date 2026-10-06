import type { ApiError } from "@fleet/contracts";
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from "fastify-type-provider-zod";
import { DeviceDirectoryUnavailableError, PublicationFailedError } from "../../application/errors.js";

export interface MappedError {
  statusCode: number;
  body: ApiError;
  /** Headers de la respuesta (p. ej. `Retry-After` en los 503). */
  headers?: Record<string, string>;
}

/**
 * `Retry-After` de los 503, en segundos: es lo que el móvil usa para el backoff de su cola. Fijo: la caída de la base o del
 * broker no da una estimación mejor, y 5 s cubre un reinicio corto sin que toda la flota reintente a la vez (el móvil le
 * suma jitter).
 */
export const SERVICE_UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

const apiError = (statusCode: number, code: string, message: string): MappedError => ({
  statusCode,
  body: { error: { code, message } },
});

const INVALID_ENVELOPE = (): MappedError =>
  apiError(400, "invalid_envelope", "El cuerpo de la petición no tiene la estructura esperada.");
const INTERNAL_ERROR = (): MappedError => apiError(500, "internal_error", "Error interno del servidor.");

const PAYLOAD_TOO_LARGE = (): MappedError =>
  apiError(413, "payload_too_large", "El cuerpo de la petición supera el tamaño máximo permitido.");
const UNSUPPORTED_MEDIA_TYPE = (): MappedError =>
  apiError(415, "unsupported_media_type", "Tipo de contenido no soportado: usa application/json.");

const retryLater = (mapped: MappedError): MappedError => ({
  ...mapped,
  headers: { "retry-after": String(SERVICE_UNAVAILABLE_RETRY_AFTER_SECONDS) },
});

const SERVICE_UNAVAILABLE = (): MappedError =>
  retryLater(apiError(503, "service_unavailable", "No se pudo registrar el lote. Reintenta: reenviarlo es seguro."));
const DIRECTORY_UNAVAILABLE = (): MappedError =>
  retryLater(apiError(503, "service_unavailable", "No se pudo verificar el dispositivo. Reintenta: reenviar el lote es seguro."));

/** Códigos de los errores de Fastify (`FST_ERR_*`) que tienen su propio código de API. */
const FASTIFY_CODES: Readonly<Record<string, () => MappedError>> = {
  FST_ERR_CTP_BODY_TOO_LARGE: PAYLOAD_TOO_LARGE,
  FST_ERR_CTP_INVALID_MEDIA_TYPE: UNSUPPORTED_MEDIA_TYPE,
};

/** Por estado HTTP, para los 4xx que no vienen de un `FST_ERR_*` conocido (p. ej. el 429 de `@fastify/rate-limit`). */
const BY_STATUS: Readonly<Record<number, () => MappedError>> = {
  400: INVALID_ENVELOPE,
  401: () => apiError(401, "unauthorized", "Credenciales ausentes o inválidas."),
  403: () => apiError(403, "forbidden", "No tienes permiso para esta operación."),
  404: () => apiError(404, "not_found", "Recurso no encontrado."),
  413: PAYLOAD_TOO_LARGE,
  415: UNSUPPORTED_MEDIA_TYPE,
  429: () => apiError(429, "rate_limited", "Demasiadas peticiones. Reintenta más tarde."),
};

export const notFoundError = (): MappedError => apiError(404, "not_found", "Recurso no encontrado.");

function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return undefined;
  return typeof error.statusCode === "number" ? error.statusCode : undefined;
}

function codeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

/**
 * Traduce cualquier error a la respuesta de la API (`apiErrorSchema`). Solo usa mensajes fijos: nunca el mensaje del
 * error original, que puede traer SQL, mensajes de `pg`, rutas o datos del punto. El detalle va al log del servidor.
 *
 * - validación de zod (body, params, querystring, headers) -> `400 invalid_envelope`;
 * - el lote no se pudo publicar en Kafka (`PublicationFailedError`) -> `503 service_unavailable` con `Retry-After`;
 * - el directorio de dispositivos no respondió al autenticar (`DeviceDirectoryUnavailableError`) -> igual, `503`;
 * - errores de Fastify con código conocido o estado 4xx -> su código de API;
 * - cualquier otra cosa (incluido un fallo al serializar la respuesta) -> `500 internal_error`.
 */
export function mapError(error: unknown): MappedError {
  if (hasZodFastifySchemaValidationErrors(error)) return INVALID_ENVELOPE();
  if (isResponseSerializationError(error)) return INTERNAL_ERROR();
  if (error instanceof PublicationFailedError) return SERVICE_UNAVAILABLE();
  if (error instanceof DeviceDirectoryUnavailableError) return DIRECTORY_UNAVAILABLE();

  const code = codeOf(error);
  const byCode = code === undefined ? undefined : FASTIFY_CODES[code];
  if (byCode !== undefined) return byCode();

  const status = statusOf(error);
  if (status !== undefined && status >= 400 && status < 500) {
    return (BY_STATUS[status] ?? (() => apiError(status, "bad_request", "Petición inválida.")))();
  }
  return INTERNAL_ERROR();
}
