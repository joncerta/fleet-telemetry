import { COLOMBIA_BBOX, isInsideBoundingBox, type BoundingBox } from "@fleet/contracts";

/**
 * Área de operación (regla 13): Colombia. El rectángulo y la documentación de sus límites viven en `@fleet/contracts` (`COLOMBIA_BBOX`),
 * fuente única compartida con la validación de zonas y el simulador. Se reexporta aquí para quienes ya la importan del dominio.
 */
export { COLOMBIA_BBOX, type BoundingBox };

/** `true` si el punto cae dentro del rectángulo (bordes incluidos). Longitud primero, como en `ST_MakePoint(lon, lat)`. */
export function isInsideOperatingArea(lon: number, lat: number, area: BoundingBox = COLOMBIA_BBOX): boolean {
  return isInsideBoundingBox(lon, lat, area);
}
