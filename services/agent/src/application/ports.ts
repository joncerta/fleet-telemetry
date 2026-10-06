import type { AlertsResponseTolerant, BreakerState, ChatResponse, FleetSummary, StoppedVehiclesResponseTolerant, ZoneKind } from "@fleet/contracts";
import type { AgentIdentity } from "../domain/identity.js";

/**
 * Quién pregunta, decidido por el SERVIDOR a partir de la sesión verificada. Viaja por el código (nunca por los argumentos de una
 * herramienta: el LLM no lo ve ni lo rellena) y es lo que fleet-api usa para filtrar por tenant.
 */
export interface UserContext {
  readonly identity: AgentIdentity;
  /** Token firmado de la cookie `fleet_session` de este usuario, que se reenvía tal cual a fleet-api. Es un secreto: nunca va a logs. */
  readonly sessionToken: string;
  /** Id de correlación de la petición, que se propaga a fleet-api. */
  readonly correlationId: string;
}

/** Por qué fleet-api no pudo responder. Ninguno es un dato de la flota. */
export type FleetUnavailableReason = "breaker_open" | "timeout" | "upstream_error" | "invalid_response";

/**
 * Resultado de una consulta a fleet-api. `unavailable` es el FALLBACK del breaker: nunca se hace pasar por datos (no lleva `data`).
 * `rejected` es un 4xx de fleet-api (sesión vencida, petición inválida): el servicio sí respondió, así que no abre el circuito.
 */
export type FleetResult<T> =
  | { readonly kind: "ok"; readonly data: T }
  | { readonly kind: "unavailable"; readonly reason: FleetUnavailableReason }
  | { readonly kind: "rejected"; readonly status: number };

/** Lecturas de fleet-api que usa el agente. Solo lectura. */
export interface FleetData {
  stoppedVehicles(
    context: UserContext,
    query: { minMinutes: number; zoneKind?: ZoneKind | undefined; limit: number },
  ): Promise<FleetResult<StoppedVehiclesResponseTolerant>>;
  fleetSummary(context: UserContext): Promise<FleetResult<FleetSummary>>;
  activeAlerts(context: UserContext, query: { limit: number }): Promise<FleetResult<AlertsResponseTolerant>>;
}

/** Estado del circuit breaker de una dependencia. */
export interface BreakerStatus {
  state(): BreakerState;
}

/** Una herramienta que el agente ejecutó, tal como sale en la respuesta del chat. */
export type ToolCallRecord = ChatResponse["toolCalls"][number];

/** Lo que devuelve el agente (el modelo y sus herramientas) ante una pregunta. */
export interface AgentRun {
  readonly answer: string;
  readonly toolCalls: readonly ToolCallRecord[];
}

/** El agente: modelo + herramientas. Lanza `AgentTimeoutError` o `AgentFailedError`; nunca otra cosa. */
export interface ChatAgent {
  run(input: { context: UserContext; message: string }): Promise<AgentRun>;
}
