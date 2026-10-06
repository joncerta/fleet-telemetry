import { INVALID_GEOMETRY_ERROR_CODE, ZONE_LIMIT_REACHED_ERROR_CODE, ZONE_MAX_PER_TENANT, ZONE_NAME_TAKEN_ERROR_CODE, type ZoneKind } from "@fleet/contracts";
import { ApiRequestError, NetworkError, UnauthorizedError } from "../../lib/api/http-client";
import type { DrawingIssue } from "./zone-drawing";

export const ZONE_KIND_OPTIONS: readonly { readonly value: ZoneKind; readonly label: string }[] = [
  { value: "critical", label: "Crítica" },
  { value: "depot", label: "Depósito" },
  { value: "customer", label: "Cliente" },
];

const KIND_LABELS: Readonly<Record<string, string>> = { critical: "Crítica", depot: "Depósito", customer: "Cliente" };

/** Etiqueta legible del tipo de zona; un tipo que esta versión no conoce se dice tal cual ("Otro"). */
export const zoneKindLabel = (kind: string): string => KIND_LABELS[kind] ?? "Otro";

export const NAME_TAKEN_MESSAGE = "Ya existe una zona con ese nombre.";
export const INVALID_GEOMETRY_MESSAGE = "El polígono no es válido (se cruza consigo mismo). Deshaz puntos o cancela y dibuja de nuevo.";
export const ZONE_LIMIT_MESSAGE = `Se alcanzó el máximo de ${String(ZONE_MAX_PER_TENANT)} zonas para tu flota.`;
const RATE_LIMITED = "Demasiadas solicitudes. Espera un momento e inténtalo de nuevo.";
const NO_CONNECTION = "No se pudo conectar con el servidor. Inténtalo de nuevo.";
const SESSION_ENDED = "Tu sesión terminó. Vuelve a ingresar.";

export interface ZoneSaveFailure {
  readonly message: string;
  /** El mensaje es del campo nombre (409 y 400 de validación): va con `aria-invalid` y `aria-describedby`; si no, es un aviso general. */
  readonly field: "name" | null;
}

/** Cómo mostrar el fallo de `POST /v1/zones`. */
export function zoneSaveFailure(error: unknown): ZoneSaveFailure {
  const general = (message: string): ZoneSaveFailure => ({ message, field: null });
  if (error instanceof NetworkError) return general(NO_CONNECTION);
  if (error instanceof UnauthorizedError) return general(SESSION_ENDED);
  if (error instanceof ApiRequestError) {
    if (error.status === 409 && error.code === ZONE_NAME_TAKEN_ERROR_CODE) return { message: NAME_TAKEN_MESSAGE, field: "name" };
    if (error.status === 409 && error.code === ZONE_LIMIT_REACHED_ERROR_CODE) return general(ZONE_LIMIT_MESSAGE);
    if (error.status === 429) return general(RATE_LIMITED);
    if (error.status === 400 && error.code === INVALID_GEOMETRY_ERROR_CODE) return general(INVALID_GEOMETRY_MESSAGE);
    if (error.status === 400) return general("El servidor no aceptó la zona. Revisa el nombre y el polígono (debe estar dentro de Colombia).");
  }
  return general("No se pudo guardar la zona. Inténtalo de nuevo.");
}

/** Texto del aviso de la última acción de dibujo rechazada. */
export function drawingIssueMessage(issue: DrawingIssue): string {
  if (issue === "self_intersection") return "Ese punto haría que el polígono se cruce consigo mismo. Elige otro lugar.";
  if (issue === "outside_colombia") return "Ese punto queda fuera de Colombia. La zona debe estar dentro del área de operación.";
  if (issue === "zero_area") return "Esos puntos no encierran un área (están en línea recta). Mueve alguno para formar un polígono.";
  if (issue === "max_vertices") return "Se alcanzó el máximo de puntos. Cierra el polígono.";
  return "Un polígono necesita al menos 3 puntos distintos.";
}
