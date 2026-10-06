import type { VehicleListResponse } from "@fleet/contracts";
import type { VehicleCatalogRepository } from "./ports.js";

export type ListVehicles = (input: { tenantId: string; limit: number }) => Promise<VehicleListResponse>;

/** Catálogo de vehículos del tenant (con o sin telemetría), por placa. El tenant lo fija quien llama con la identidad de la sesión. */
export function createListVehicles(deps: { catalog: VehicleCatalogRepository }): ListVehicles {
  return async ({ tenantId, limit }) => ({ items: await deps.catalog.list(tenantId, limit), limit });
}
