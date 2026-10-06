import type { StoppedVehiclesQuery, StoppedVehiclesResponse } from "@fleet/contracts";
import { noSignalCutoff, pickDisplayZone, stoppedMinutes, stoppedSinceCutoff } from "../domain/fleet-status.js";
import type { Clock, StoppedVehicleReader } from "./ports.js";

export type ListStoppedVehicles = (input: { tenantId: string } & StoppedVehiclesQuery) => Promise<StoppedVehiclesResponse>;

/**
 * Responde "qué vehículos llevan más de X minutos detenidos". Reglas:
 * - detenidos con `stoppedMinutes >= minMinutes`, filtrando por el tipo de zona si viene;
 * - EXCLUYE los vehículos sin señal: su estado es viejo y `stoppedMinutes` mentiría (ADR-006, pendiente);
 * - con varias zonas, muestra la crítica primero (`pickDisplayZone`);
 * - los que llevan más tiempo primero, con orden estable, y a lo sumo `limit`.
 */
export function createListStoppedVehicles(deps: { reader: StoppedVehicleReader; clock: Clock }): ListStoppedVehicles {
  return async ({ tenantId, minMinutes, zoneKind, limit }) => {
    const serverTime = deps.clock.now();
    const rows = await deps.reader.findStopped({
      tenantId,
      stoppedAtOrBefore: stoppedSinceCutoff(serverTime, minMinutes),
      signalSince: noSignalCutoff(serverTime),
      zoneKind,
      limit,
    });
    return {
      serverTime: serverTime.toISOString(),
      items: rows.map((row) => ({
        vehicleId: row.vehicleId,
        plate: row.plate,
        stoppedSince: row.stoppedSince.toISOString(),
        stoppedMinutes: stoppedMinutes(row.stoppedSince, serverTime),
        lon: row.lon,
        lat: row.lat,
        zone: pickDisplayZone(row.zones, zoneKind),
      })),
    };
  };
}
