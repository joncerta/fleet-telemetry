import { z } from "zod";
import type { FleetResult, FleetUnavailableReason } from "./ports.js";

/**
 * Lo que una herramienta le devuelve al LLM (como JSON en el mensaje de la herramienta). Siempre lleva `status`: así el modelo
 * distingue datos de un fallo y el system prompt le obliga a decirlo, no a inventar (regla 10 de CLAUDE.md).
 *
 * - `ok`: datos de fleet-api, ya acotados (ver `domain/fleet-views.ts`).
 * - `unavailable`: fleet-api no respondió (breaker abierto, timeout, error). NO hay datos.
 * - `rejected`: fleet-api respondió con un 4xx (p. ej. la sesión venció). NO hay datos.
 */
export type ToolResult<T> =
  | { readonly status: "ok"; readonly data: T }
  | { readonly status: "unavailable"; readonly reason: FleetUnavailableReason; readonly message: string }
  | { readonly status: "rejected"; readonly message: string };

/** Mensaje al modelo cuando fleet-api no está disponible. El del breaker abierto es el que fija la historia del fallback. */
export const UNAVAILABLE_MESSAGES: Readonly<Record<FleetUnavailableReason, string>> = {
  breaker_open: "fleet-api no disponible (breaker abierto). No hay datos disponibles.",
  timeout: "fleet-api no respondió a tiempo. No hay datos disponibles.",
  upstream_error: "fleet-api devolvió un error. No hay datos disponibles.",
  invalid_response: "fleet-api devolvió una respuesta que no se pudo interpretar. No hay datos disponibles.",
};

const REJECTED_AUTH_MESSAGE = "fleet-api rechazó la sesión del usuario (vencida o sin permiso). No hay datos disponibles.";
const REJECTED_OTHER_MESSAGE = "fleet-api rechazó la consulta. No hay datos disponibles.";

/** Traduce el resultado de fleet-api al de la herramienta, proyectando los datos con `project` (acotados en filas y campos). */
export function toToolResult<T, V>(result: FleetResult<T>, project: (data: T) => V): ToolResult<V> {
  switch (result.kind) {
    case "ok":
      return { status: "ok", data: project(result.data) };
    case "unavailable":
      return { status: "unavailable", reason: result.reason, message: UNAVAILABLE_MESSAGES[result.reason] };
    case "rejected":
      return { status: "rejected", message: result.status === 401 || result.status === 403 ? REJECTED_AUTH_MESSAGE : REJECTED_OTHER_MESSAGE };
  }
}

/** Esquema del JSON que ve el modelo. Lo usa el modelo con guion para leer el resultado real de la herramienta. */
export const toolResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), data: z.unknown() }),
  z.object({ status: z.literal("unavailable"), reason: z.string(), message: z.string() }),
  z.object({ status: z.literal("rejected"), message: z.string() }),
]);
