import type { ZoneCreateRequest, ZoneFeature } from "@fleet/contracts";
import type { AuthIdentity } from "../domain/identity.js";
import { InvalidZoneGeometryError, ZoneNameTakenError } from "./errors.js";
import type { ZoneRepository } from "./ports.js";

export interface CreateZoneDependencies {
  zones: ZoneRepository;
  /** Genera el id de la zona (uuid): lo decide el servidor, nunca el cliente. */
  newZoneId: () => string;
}

export type CreateZone = (input: { identity: AuthIdentity; zone: ZoneCreateRequest }) => Promise<ZoneFeature>;

/**
 * Alta de una zona en el tenant de la SESIÓN. El nombre, el tipo y la forma del polígono (un anillo cerrado dentro de Colombia) ya los
 * validó `zoneCreateRequestSchema` en el borde; que no se auto-intersecte lo decide PostGIS al guardar. Un nombre que ya existe en el
 * tenant es `ZoneNameTakenError` (409); el mismo en otro tenant es válido; un polígono inválido es `InvalidZoneGeometryError` (400).
 */
export function createCreateZone(deps: CreateZoneDependencies): CreateZone {
  return async ({ identity, zone }) => {
    const result = await deps.zones.create({
      tenantId: identity.tenantId,
      zoneId: deps.newZoneId(),
      name: zone.name,
      kind: zone.kind,
      geometry: zone.geometry,
    });
    if (result.status === "name_taken") throw new ZoneNameTakenError();
    if (result.status === "invalid_geometry") throw new InvalidZoneGeometryError();
    return result.zone;
  };
}
