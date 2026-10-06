import { toAlertsView, type AlertsView } from "../domain/fleet-views.js";
import type { FleetData, UserContext } from "./ports.js";
import { toToolResult, type ToolResult } from "./tool-result.js";

export type GetActiveAlerts = (context: UserContext, input: { limit: number }) => Promise<ToolResult<AlertsView>>;

/** Alertas activas (sin resolver) de la flota del usuario, de la más reciente a la más antigua. */
export function createGetActiveAlerts(deps: { fleet: FleetData }): GetActiveAlerts {
  return async (context, input) => toToolResult(await deps.fleet.activeAlerts(context, input), (data) => toAlertsView(data, input.limit));
}
