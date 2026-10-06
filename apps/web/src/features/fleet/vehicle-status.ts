import { hasNoSignal, type VehicleStateTolerant, type ZoneFeatureCollectionTolerant } from "@fleet/contracts";
import type { VehicleStatus } from "../../design/tokens";

/** Ids de las zonas `critical` del tenant: un vehículo detenido en una de ellas se muestra como `stopped_critical`. */
export function criticalZoneIdsOf(zones: ZoneFeatureCollectionTolerant | null): ReadonlySet<string> {
  if (zones === null) return new Set();
  return new Set(zones.features.filter((feature) => feature.properties.kind === "critical").map((feature) => feature.properties.zoneId));
}

/**
 * Estado visual de un vehículo contra la hora del servidor.
 * - `no_signal` gana a todo: si el último punto tiene más de `NO_SIGNAL_THRESHOLD_MS`, su posición y su movimiento son VIEJOS y no se
 *   muestran como actuales (se recalcula en el cliente con `hasNoSignal`, igual que fleet-api al leer).
 * - `stopped` dentro de una zona crítica es `stopped_critical`.
 * - Un `movement` que esta versión no conoce (lectura tolerante) es `unknown`, nunca se adivina.
 */
export function vehicleStatusOf(vehicle: VehicleStateTolerant, serverNowIso: string, criticalZoneIds: ReadonlySet<string>): VehicleStatus {
  if (hasNoSignal(vehicle.receivedAt, serverNowIso)) return "no_signal";
  switch (vehicle.movement) {
    case "moving":
      return "moving";
    case "stopped":
      return vehicle.zoneIds.some((zoneId) => criticalZoneIds.has(zoneId)) ? "stopped_critical" : "stopped";
    default:
      return "unknown";
  }
}

/** Velocidad en km/h redondeada, o `null` si el GPS no la entregó. */
export function speedKmh(speedMps: number | null): number | null {
  return speedMps === null ? null : Math.round(speedMps * 3.6);
}
