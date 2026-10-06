/** Radio medio de la Tierra (m), el de la esfera de la fórmula del haversine. */
const EARTH_RADIUS_M = 6_371_008.8;

export interface Position {
  /** Longitud en grados (primero, como en `ST_MakePoint(lon, lat)`). */
  readonly lon: number;
  /** Latitud en grados. */
  readonly lat: number;
}

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/**
 * Distancia en metros entre dos posiciones sobre una esfera (haversine). Para los umbrales de detención (decenas de metros)
 * el error frente al elipsoide es despreciable (< 0,5 %), y mantiene el dominio puro; las consultas de la base usan
 * `geography` para lo que sí necesita exactitud.
 */
export function haversineMeters(a: Position, b: Position): number {
  const deltaLat = toRadians(b.lat - a.lat);
  const deltaLon = toRadians(b.lon - a.lon);
  const h = Math.sin(deltaLat / 2) ** 2 + Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(deltaLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}
