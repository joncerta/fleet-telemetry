/** Rectángulo en grados WGS84 (SRID 4326). Los bordes cuentan como dentro. */
export interface BoundingBox {
  readonly minLon: number;
  readonly maxLon: number;
  readonly minLat: number;
  readonly maxLat: number;
}

/**
 * Área de operación: Colombia, incluidos San Andrés y Providencia (regla 13 de CLAUDE.md).
 *
 * ES UN RECTÁNGULO (bbox), NO UN POLÍGONO. Deja pasar puntos que no están en Colombia pero caen dentro del rectángulo:
 * buena parte de Venezuela, Ecuador, Perú y Brasil, y casi todo Panamá (Ciudad de Panamá incluida: lon -79,5). Solo
 * descarta lo evidentemente ajeno (otros continentes, un GPS en 0,0, un intercambio de lon y lat, el occidente de Panamá
 * y Centroamérica). Afinarlo con un polígono (`ST_Covers`) sería un cambio de esta regla, no un arreglo.
 *
 * Origen de los límites: los puntos extremos del territorio según el IGAC, redondeados hacia afuera para dar margen:
 * - occidente: Cabo Manglares (Nariño) lon -79,02 en el continente; en el Caribe, los cayos de Albuquerque (San Andrés)
 *   lon -81,85, que fija el límite occidental en -82,0;
 * - oriente: la isla San José en el río Negro (Guainía) lon -66,85, de ahí -66,8;
 * - norte: Punta Gallinas (La Guajira) lat 12,46 en el continente; Providencia lat 13,35 y el cayo Roncador lat 13,57 en el
 *   Caribe, de ahí 13,6. Quedan fuera los cayos Serrana, Quitasueño, Serranilla y Bajo Nuevo (lat > 14), deshabitados;
 * - sur: la quebrada San Antonio en el Amazonas (Leticia) lat -4,23, de ahí -4,3.
 * Los valores son de referencia y no se pudieron contrastar contra la fuente oficial al escribirlos: quien los cambie debe
 * citar la fuente y ajustar `operating-area.test.ts`.
 */
export const COLOMBIA_BBOX: BoundingBox = { minLon: -82.0, maxLon: -66.8, minLat: -4.3, maxLat: 13.6 };

/** `true` si el punto cae dentro del rectángulo (bordes incluidos). Longitud primero, como en `ST_MakePoint(lon, lat)`. */
export function isInsideOperatingArea(lon: number, lat: number, area: BoundingBox = COLOMBIA_BBOX): boolean {
  return lon >= area.minLon && lon <= area.maxLon && lat >= area.minLat && lat <= area.maxLat;
}
