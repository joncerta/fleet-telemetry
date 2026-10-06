import type { VehicleStateTolerant } from "@fleet/contracts";
import type { VehicleStatus } from "../../design/tokens";
import { minutesSince } from "../../lib/time/server-clock";
import { vehicleStatusOf } from "../fleet/vehicle-status";

export interface VehicleRow {
  readonly vehicle: VehicleStateTolerant;
  readonly status: VehicleStatus;
  /** Minutos desde el último dato recibido (`receivedAt`) contra la hora del servidor. */
  readonly minutesSinceData: number;
}

const byPlate = new Intl.Collator("es-CO", { numeric: true, sensitivity: "base" });

/** Filas de la lista de vehículos (la alternativa accesible al canvas del mapa), ordenadas por placa. */
export function vehicleRows(
  vehicles: Readonly<Record<string, VehicleStateTolerant>>,
  serverNowMs: number,
  criticalZoneIds: ReadonlySet<string>,
): VehicleRow[] {
  const serverNowIso = new Date(serverNowMs).toISOString();
  return Object.values(vehicles)
    .map((vehicle) => ({
      vehicle,
      status: vehicleStatusOf(vehicle, serverNowIso, criticalZoneIds),
      minutesSinceData: minutesSince(vehicle.receivedAt, serverNowMs),
    }))
    .sort((a, b) => byPlate.compare(a.vehicle.plate, b.vehicle.plate));
}
