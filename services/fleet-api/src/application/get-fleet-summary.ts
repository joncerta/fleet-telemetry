import type { FleetSummary } from "@fleet/contracts";
import { noSignalCutoff } from "../domain/fleet-status.js";
import type { Clock, SummaryReader } from "./ports.js";

export type GetFleetSummary = (input: { tenantId: string }) => Promise<FleetSummary>;

/**
 * Resumen de la flota del tenant. `noSignal` se deriva al LEER contra la hora del servidor (ADR-006.3) y los conteos particionan la
 * flota: `total = moving + stopped + noSignal`, así que un vehículo sin señal no cuenta también como `moving` o `stopped`.
 */
export function createGetFleetSummary(deps: { reader: SummaryReader; clock: Clock }): GetFleetSummary {
  return async ({ tenantId }) => {
    const serverTime = deps.clock.now();
    const [counts, activeAlerts] = await Promise.all([
      deps.reader.countVehicleStatus(tenantId, noSignalCutoff(serverTime)),
      deps.reader.countActiveAlerts(tenantId),
    ]);
    return {
      serverTime: serverTime.toISOString(),
      vehicles: { total: counts.moving + counts.stopped + counts.noSignal, ...counts },
      activeAlerts,
    };
  };
}
