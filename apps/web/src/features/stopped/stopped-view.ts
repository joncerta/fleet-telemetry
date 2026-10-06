import type { StoppedVehiclesResponseTolerant, VehicleStateTolerant } from "@fleet/contracts";
import { minutesSince } from "../../lib/time/server-clock";

export type StoppedItem = StoppedVehiclesResponseTolerant["items"][number];

export interface StoppedRow {
  readonly item: StoppedItem;
  /** Minutos detenido contra la hora del SERVIDOR, recalculados en el cliente (avanzan con el tick sin pedir de nuevo la lista). */
  readonly minutes: number;
}

/**
 * Filas de "detenidos más de N minutos" a partir de la última lectura de `/v1/vehicles/stopped` y del estado EN VIVO:
 * - si el estado en vivo de un vehículo ya no está detenido, o empezó otra detención (otro `stoppedSince`), la fila es vieja y se quita
 *   (la próxima recarga traerá la verdad);
 * - los minutos se calculan desde `stoppedSince` con la hora del servidor, no con el reloj del navegador; nunca bajan de `minMinutes`
 *   (el servidor ya lo verificó con su reloj: un desfase estimado de unos segundos no debe mostrar "19 min" en la lista de "más de 20").
 * Orden: más minutos primero.
 */
export function stoppedRows(
  items: readonly StoppedItem[],
  liveVehicles: Readonly<Record<string, VehicleStateTolerant>>,
  serverNowMs: number,
  minMinutes: number,
): StoppedRow[] {
  return items
    .filter((item) => {
      const live = liveVehicles[item.vehicleId];
      if (live === undefined) return true;
      return live.movement === "stopped" && live.stoppedSince !== null && Date.parse(live.stoppedSince) === Date.parse(item.stoppedSince);
    })
    .map((item) => ({ item, minutes: Math.max(minMinutes, minutesSince(item.stoppedSince, serverNowMs)) }))
    .sort((a, b) => b.minutes - a.minutes);
}
