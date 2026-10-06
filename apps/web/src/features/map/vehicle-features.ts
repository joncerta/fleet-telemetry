import type { VehicleStateTolerant } from "@fleet/contracts";
import type { VehicleStatus } from "../../design/tokens";
import { vehicleStatusOf } from "../fleet/vehicle-status";

// `type` (no `interface`): las propiedades de GeoJSON son un índice de strings y solo un alias de tipo es asignable a él.
export type VehicleFeatureProperties = {
  vehicleId: string;
  status: VehicleStatus;
  /** Orden de dibujo (`symbol-sort-key`): lo más urgente queda encima. */
  rank: number;
};

export type VehicleFeature = {
  type: "Feature";
  id: string;
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: VehicleFeatureProperties;
};

export type VehicleFeatureCollection = { type: "FeatureCollection"; features: VehicleFeature[] };

const RANK: Record<VehicleStatus, number> = { stopped_critical: 4, stopped: 3, moving: 2, no_signal: 1, unknown: 0 };

/**
 * La flota como UNA FeatureCollection para la fuente GeoJSON del mapa (se actualiza con `setData`, nunca un marker por vehículo).
 * Coordenadas en orden `[lng, lat]` (regla 13). Las propiedades llevan solo el id y el estado: ni placa ni otros datos personales.
 */
export function toVehicleFeatures(
  vehicles: Readonly<Record<string, VehicleStateTolerant>>,
  serverNowIso: string,
  criticalZoneIds: ReadonlySet<string>,
): VehicleFeatureCollection {
  const features: VehicleFeature[] = [];
  for (const vehicle of Object.values(vehicles)) {
    const status = vehicleStatusOf(vehicle, serverNowIso, criticalZoneIds);
    features.push({
      type: "Feature",
      id: vehicle.vehicleId,
      geometry: { type: "Point", coordinates: [vehicle.lon, vehicle.lat] },
      properties: { vehicleId: vehicle.vehicleId, status, rank: RANK[status] },
    });
  }
  return { type: "FeatureCollection", features };
}
