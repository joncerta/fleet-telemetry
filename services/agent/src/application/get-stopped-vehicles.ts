import type { ZoneKind } from "@fleet/contracts";
import { toStoppedVehiclesView, type StoppedVehiclesView } from "../domain/fleet-views.js";
import type { FleetData, UserContext } from "./ports.js";
import { toToolResult, type ToolResult } from "./tool-result.js";

export interface GetStoppedVehiclesInput {
  minMinutes: number;
  zoneKind?: ZoneKind | undefined;
  limit: number;
}

export type GetStoppedVehicles = (context: UserContext, input: GetStoppedVehiclesInput) => Promise<ToolResult<StoppedVehiclesView>>;

/** "Qué vehículos llevan más de X minutos detenidos" (B1): consulta fleet-api con la sesión del usuario y acota lo que ve el modelo. */
export function createGetStoppedVehicles(deps: { fleet: FleetData }): GetStoppedVehicles {
  return async (context, input) => toToolResult(await deps.fleet.stoppedVehicles(context, input), (data) => toStoppedVehiclesView(data, input.limit));
}
