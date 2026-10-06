import type { City } from "./cities.js";
import { METERS_PER_DEGREE_LAT, metersPerDegreeLon } from "./geo.js";
import type { Rng } from "./rng.js";

/** Distancia entre esquinas de la cuadrícula, en metros: una cuadra. */
export const BLOCK_METERS = 120;

export interface RoutePosition {
  lon: number;
  lat: number;
  /** Rumbo en grados desde el norte, de 0 a menos de 360. */
  headingDeg: number;
}

export interface RouteWalker {
  /** Posición actual sobre la calle (sin ruido de GPS). */
  position(): RoutePosition;
  /** Avanza `meters` por las calles. Devuelve cuántas esquinas cruzó (para simular semáforos). */
  advance(meters: number): number;
}

type Direction = readonly [di: number, dj: number];
const NORTH: Direction = [0, 1];
const EAST: Direction = [1, 0];
const SOUTH: Direction = [0, -1];
const WEST: Direction = [-1, 0];

const HEADING_OF = new Map<Direction, number>([
  [NORTH, 0],
  [EAST, 90],
  [SOUTH, 180],
  [WEST, 270],
]);

const turnLeft = (d: Direction): Direction => (d === NORTH ? WEST : d === WEST ? SOUTH : d === SOUTH ? EAST : NORTH);
const turnRight = (d: Direction): Direction => (d === NORTH ? EAST : d === EAST ? SOUTH : d === SOUTH ? WEST : NORTH);

/**
 * Recorrido sobre una cuadrícula de calles de `BLOCK_METERS` alineada con los ejes, dentro del rectángulo de la ciudad: sigue
 * derecho el 60 % de las esquinas y gira a izquierda o derecha el resto, sin dar la vuelta en U; en el borde de la ciudad
 * gira. No hay datos de calles reales: es una aproximación de una ciudad en damero (con rumbos, giros y esquinas) que
 * nunca sale del rectángulo, así que nunca sale de Colombia.
 */
export function createRouteWalker(city: City, rng: Rng): RouteWalker {
  const midLat = (city.south + city.north) / 2;
  const dLon = BLOCK_METERS / metersPerDegreeLon(midLat);
  const dLat = BLOCK_METERS / METERS_PER_DEGREE_LAT;
  const cols = Math.floor((city.east - city.west) / dLon);
  const rows = Math.floor((city.north - city.south) / dLat);
  if (cols < 1 || rows < 1) throw new Error("La ciudad es demasiado pequeña para la cuadrícula.");

  const inside = (i: number, j: number): boolean => i >= 0 && i <= cols && j >= 0 && j <= rows;

  let i = Math.floor(rng.range(0, cols + 1));
  let j = Math.floor(rng.range(0, rows + 1));
  const starts = [NORTH, EAST, SOUTH, WEST].filter(([di, dj]) => inside(i + di, j + dj));
  let direction: Direction = starts[Math.floor(rng.range(0, starts.length))] ?? NORTH;
  let progressM = 0;

  const chooseNext = (): Direction => {
    const options: { direction: Direction; weight: number }[] = [
      { direction, weight: 0.6 },
      { direction: turnLeft(direction), weight: 0.2 },
      { direction: turnRight(direction), weight: 0.2 },
    ].filter(({ direction: d }) => inside(i + d[0], j + d[1]));
    if (options.length === 0) return direction === NORTH ? SOUTH : direction === SOUTH ? NORTH : direction === EAST ? WEST : EAST;
    const total = options.reduce((sum, option) => sum + option.weight, 0);
    let pick = rng.range(0, total);
    for (const option of options) {
      pick -= option.weight;
      if (pick < 0) return option.direction;
    }
    return options[0]?.direction ?? direction;
  };

  return {
    position() {
      const fraction = progressM / BLOCK_METERS;
      return {
        lon: city.west + (i + direction[0] * fraction) * dLon,
        lat: city.south + (j + direction[1] * fraction) * dLat,
        headingDeg: HEADING_OF.get(direction) ?? 0,
      };
    },
    advance(meters) {
      let remaining = Math.max(0, meters);
      let corners = 0;
      while (remaining > 0) {
        const left = BLOCK_METERS - progressM;
        if (remaining < left) {
          progressM += remaining;
          break;
        }
        remaining -= left;
        i += direction[0];
        j += direction[1];
        progressM = 0;
        corners += 1;
        direction = chooseNext();
      }
      return corners;
    },
  };
}
