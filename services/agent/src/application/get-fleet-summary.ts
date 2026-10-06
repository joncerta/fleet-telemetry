import { toFleetSummaryView, type FleetSummaryView } from "../domain/fleet-views.js";
import type { FleetData, UserContext } from "./ports.js";
import { toToolResult, type ToolResult } from "./tool-result.js";

export type GetFleetSummary = (context: UserContext) => Promise<ToolResult<FleetSummaryView>>;

/** Resumen de la flota del usuario (conteos por estado y alertas activas). */
export function createGetFleetSummary(deps: { fleet: FleetData }): GetFleetSummary {
  return async (context) => toToolResult(await deps.fleet.fleetSummary(context), toFleetSummaryView);
}
