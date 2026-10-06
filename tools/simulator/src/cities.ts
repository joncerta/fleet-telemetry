import { COLOMBIA_BBOX } from "@fleet/contracts";
import { SEED_TENANTS } from "@fleet/dev-data";

/** Rectángulo de una ciudad en grados. Las rutas de sus vehículos no salen de él. */
export interface City {
  tenantId: string;
  name: string;
  west: number;
  south: number;
  east: number;
  north: number;
  /** Altitud aproximada sobre el nivel del mar, en metros. */
  altitudeM: number;
}

/**
 * Área de operación (`COLOMBIA_BBOX` de `@fleet/contracts`, regla 13): el simulador nunca debe generar un punto fuera de ella o el
 * processor lo mandaría a la DLQ como `outside_operating_area`. Es un rectángulo, no un polígono. Misma constante que usa el processor;
 * los tests comprueban que los puntos caen dentro.
 */
export const OPERATING_AREA = COLOMBIA_BBOX;

interface CityShape extends Omit<City, "tenantId"> {
  tenantName: string;
}

// Rectángulos más grandes que las zonas sembradas (que están dentro): Bogotá para Flota Norte y Medellín para Flota Sur.
const SHAPES: readonly CityShape[] = [
  { tenantName: "Flota Norte", name: "Bogotá", west: -74.17, south: 4.58, east: -74.03, north: 4.78, altitudeM: 2_600 },
  { tenantName: "Flota Sur", name: "Medellín", west: -75.62, south: 6.2, east: -75.54, north: 6.3, altitudeM: 1_495 },
];

/** Ciudad de cada tenant sembrado. Lanza si `@fleet/dev-data` cambió los nombres de los tenants. */
export function citiesOfSeedTenants(): readonly City[] {
  return SEED_TENANTS.map((tenant) => {
    const shape = SHAPES.find((candidate) => candidate.tenantName === tenant.name);
    if (shape === undefined) throw new Error(`El tenant "${tenant.name}" no tiene ciudad en el simulador.`);
    return { tenantId: tenant.id, name: shape.name, west: shape.west, south: shape.south, east: shape.east, north: shape.north, altitudeM: shape.altitudeM };
  });
}
