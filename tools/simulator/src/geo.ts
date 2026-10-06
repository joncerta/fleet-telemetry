/** Metros por grado de latitud (esfera de 6 371 km): suficiente para desplazamientos de decenas de metros. */
export const METERS_PER_DEGREE_LAT = 111_195;

/** Metros por grado de longitud a una latitud dada. */
export function metersPerDegreeLon(lat: number): number {
  return METERS_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180);
}

/** Desplaza `[lon, lat]` por `eastM` y `northM` metros. Devuelve `[lon, lat]`. */
export function offsetLonLat(lon: number, lat: number, eastM: number, northM: number): [number, number] {
  return [lon + eastM / metersPerDegreeLon(lat), lat + northM / METERS_PER_DEGREE_LAT];
}
