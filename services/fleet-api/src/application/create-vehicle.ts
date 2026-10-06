import type { VehicleCatalogItem, VehicleCreateRequest } from "@fleet/contracts";
import type { AuthIdentity } from "../domain/identity.js";
import { PlateTakenError } from "./errors.js";
import type { VehicleCatalogRepository } from "./ports.js";

export interface CreateVehicleDependencies {
  catalog: VehicleCatalogRepository;
  /** Genera el id del vehículo (uuid): lo decide el servidor, nunca el cliente. */
  newVehicleId: () => string;
}

export type CreateVehicle = (input: { identity: AuthIdentity; vehicle: VehicleCreateRequest }) => Promise<VehicleCatalogItem>;

/**
 * Alta de un vehículo en el tenant de la SESIÓN. La placa ya llega normalizada (la normaliza `vehicleCreateRequestSchema` en el borde).
 * Una placa que ya existe en el tenant es `PlateTakenError` (409); la misma placa en otro tenant es válida.
 */
export function createCreateVehicle(deps: CreateVehicleDependencies): CreateVehicle {
  return async ({ identity, vehicle }) => {
    const result = await deps.catalog.create({
      tenantId: identity.tenantId,
      vehicleId: deps.newVehicleId(),
      plate: vehicle.plate,
      label: vehicle.label,
    });
    if (result.status === "plate_taken") throw new PlateTakenError();
    return result.vehicle;
  };
}
