import type { AgentFailureInfo } from "../application/errors.js";

/**
 * Resumen SEGURO de un error del proveedor del modelo (Anthropic vía LangChain), para el log. Es duck-typing sobre la forma de los errores
 * del SDK (`status`, `type`, `requestID`, `error.error.type`): no importa el SDK. Nunca incluye `message` (puede traer la pregunta, una
 * clave o un id de cuenta), cabeceras ni el cuerpo: cada campo sale de una allowlist o de un patrón cerrado.
 */

/** Cuántos eslabones de `cause` se recorren (LangChain -> SDK ...). Acota ciclos. */
const MAX_CAUSE_DEPTH = 6;

/** `error.type` documentados de la API de Anthropic. Todo lo demás se omite: el cuerpo viene de un tercero y no se vuelca al log. */
const PROVIDER_ERROR_TYPES: ReadonlySet<string> = new Set([
  "invalid_request_error",
  "authentication_error",
  "billing_error",
  "permission_error",
  "not_found_error",
  "request_too_large",
  "rate_limit_error",
  "timeout_error",
  "api_error",
  "overloaded_error",
]);

/** Nombre de clase con forma de identificador: un `name` puesto a mano (con texto libre) no llega al log. */
const CLASS_NAME_PATTERN = /^[A-Za-z_$][\w$]{0,63}$/;

/** Id de petición de Anthropic (`req_...`), útil para soporte. */
const REQUEST_ID_PATTERN = /^req_[A-Za-z0-9]{1,64}$/;

/** El proveedor rechaza la configuración del servicio, no la pregunta: clave inválida (401), sin permiso o workspace (403), modelo inexistente (404). */
const MISCONFIGURED_STATUSES: ReadonlySet<number> = new Set([401, 403, 404]);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** Código HTTP del error (`status`), si es un entero válido. Lo comparte el breaker del modelo para decidir qué 4xx no cuentan. */
export function statusOf(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  const status = error["status"];
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}

/** Los errores del SDK de Anthropic no fijan `name` (queda "Error"): la clase la dice el constructor. */
function nameOf(error: unknown): string {
  if (!(error instanceof Error)) return "Error";
  const constructorName = error.constructor.name;
  const name = error.name !== "Error" ? error.name : constructorName;
  return CLASS_NAME_PATTERN.test(name) ? name : "Error";
}

function errorTypeOf(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  const body = error["error"];
  const nested = isRecord(body) && isRecord(body["error"]) ? body["error"]["type"] : undefined;
  for (const candidate of [error["type"], nested]) {
    if (typeof candidate === "string" && PROVIDER_ERROR_TYPES.has(candidate)) return candidate;
  }
  return undefined;
}

function requestIdOf(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  const id = error["requestID"];
  return typeof id === "string" && REQUEST_ID_PATTERN.test(id) ? id : undefined;
}

function build(error: unknown, status: number | undefined): AgentFailureInfo {
  const errorType = errorTypeOf(error);
  const requestId = requestIdOf(error);
  return {
    causeName: nameOf(error),
    ...(status !== undefined && { causeStatus: status }),
    ...(errorType !== undefined && { causeErrorType: errorType }),
    ...(requestId !== undefined && { providerRequestId: requestId }),
    providerMisconfigured: status !== undefined && MISCONFIGURED_STATUSES.has(status),
  };
}

/**
 * Describe el error que lanzó el modelo. Recorre la cadena `cause` (LangChain puede envolverlo) y toma el primer eslabón con estado
 * HTTP; sin ninguno, describe el error recibido. Pura: no lanza ni toca nada. Se llama con el error CRUDO, en el punto donde el
 * adaptador lo envuelve: así lo que se describe es lo que salió del modelo y no un error de otra parte.
 */
export function describeProviderError(error: unknown): AgentFailureInfo {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined && current !== null; depth += 1) {
    const status = statusOf(current);
    if (status !== undefined) return build(current, status);
    current = current instanceof Error ? current.cause : undefined;
  }
  return build(error, undefined);
}
