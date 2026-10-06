import type { ZoneFeatureCollection } from "@fleet/contracts";
import type { ZoneReader } from "./ports.js";

export type GetZonesGeoJson = (input: { tenantId: string }) => Promise<ZoneFeatureCollection>;

/** Zonas del tenant como GeoJSON, coordenadas `[lng, lat]` (regla 13). Solo las de ese tenant. */
export function createGetZonesGeoJson(deps: { reader: ZoneReader }): GetZonesGeoJson {
  return ({ tenantId }) => deps.reader.findZones(tenantId);
}
