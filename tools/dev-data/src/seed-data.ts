import type { ZoneKind } from "@fleet/contracts";

/**
 * Datos de demo (solo local). Los UUID son fijos y de versión 4 con variante RFC 4122, para que pasen `z.uuid()` de
 * `@fleet/contracts`: el simulador de la fase 1b los usa como `vehicleId` y el seed es idempotente por `id`.
 * Las placas, las zonas y los usuarios son inventados; no corresponden a vehículos, lugares ni personas reales.
 */
export const VEHICLES_PER_TENANT = 15;

export interface SeedTenant {
  id: string;
  name: string;
  /** Prefijo de las placas inventadas del tenant. */
  platePrefix: string;
  /** Base numérica de los UUID de sus vehículos: separa los de un tenant de los de otro. */
  vehicleIdBase: number;
}

export interface SeedVehicle {
  id: string;
  tenantId: string;
  plate: string;
  label: string;
}

const NORTE: SeedTenant = { id: "f1ee7000-0000-4000-8000-000000000001", name: "Flota Norte", platePrefix: "NRT", vehicleIdBase: 1_000 };
const SUR: SeedTenant = { id: "f1ee7000-0000-4000-8000-000000000002", name: "Flota Sur", platePrefix: "SUR", vehicleIdBase: 2_000 };

export const SEED_TENANTS: readonly SeedTenant[] = [NORTE, SUR];

/** `f1ee7000-0000-4000-9000-<12 dígitos>`: determinista y único por tenant y número de vehículo. */
export function vehicleIdOf(tenant: SeedTenant, number: number): string {
  return `f1ee7000-0000-4000-9000-${String(tenant.vehicleIdBase + number).padStart(12, "0")}`;
}

export function seedVehicles(tenants: readonly SeedTenant[] = SEED_TENANTS, perTenant = VEHICLES_PER_TENANT): SeedVehicle[] {
  return tenants.flatMap((tenant) =>
    Array.from({ length: perTenant }, (_, index) => {
      const number = index + 1;
      return {
        id: vehicleIdOf(tenant, number),
        tenantId: tenant.id,
        // NRT101, NRT102... SUR101...: tres letras y tres dígitos, como las placas colombianas.
        plate: `${tenant.platePrefix}${String(100 + number)}`,
        label: `${tenant.name} ${String(number).padStart(2, "0")}`,
      };
    }),
  );
}

/** Un polígono de demo. */
export interface SeedZone {
  zoneId: string;
  tenantId: string;
  name: string;
  kind: ZoneKind;
  /** Anillo exterior, cerrado (el primer punto se repite al final), en `[lng, lat]` (regla 13: longitud primero). */
  ring: readonly (readonly [number, number])[];
}

/** Rectángulo cerrado de `[lng, lat]` a partir de sus bordes: oeste, sur, este y norte. */
function rectangle(west: number, south: number, east: number, north: number): SeedZone["ring"] {
  return [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ];
}

/** `f1ee7000-0000-4000-a000-<12 dígitos>`: variante RFC 4122 válida para `z.uuid()`, distinta de la de tenants y vehículos. */
const zoneIdOf = (number: number): string => `f1ee7000-0000-4000-a000-${String(number).padStart(12, "0")}`;

/**
 * Zonas INVENTADAS por tenant: rectángulos de ~500 m en barrios genéricos de Bogotá (Flota Norte) y Medellín (Flota Sur). No
 * corresponden a instalaciones reales ni a lugares sensibles: son solo geometría para probar zonas críticas, depósitos y clientes.
 * Cada tenant tiene 2 críticas, 1 depósito y 1 cliente, y no se solapan entre sí.
 */
export const SEED_ZONES: readonly SeedZone[] = [
  { zoneId: zoneIdOf(1), tenantId: NORTE.id, name: "Zona crítica Norte 1", kind: "critical", ring: rectangle(-74.0905, 4.724, -74.0845, 4.729) },
  { zoneId: zoneIdOf(2), tenantId: NORTE.id, name: "Zona crítica Norte 2", kind: "critical", ring: rectangle(-74.118, 4.642, -74.112, 4.647) },
  { zoneId: zoneIdOf(3), tenantId: NORTE.id, name: "Depósito Norte", kind: "depot", ring: rectangle(-74.062, 4.67, -74.056, 4.675) },
  { zoneId: zoneIdOf(4), tenantId: NORTE.id, name: "Cliente Norte", kind: "customer", ring: rectangle(-74.045, 4.685, -74.04, 4.689) },
  { zoneId: zoneIdOf(5), tenantId: SUR.id, name: "Zona crítica Sur 1", kind: "critical", ring: rectangle(-75.59, 6.22, -75.584, 6.225) },
  { zoneId: zoneIdOf(6), tenantId: SUR.id, name: "Zona crítica Sur 2", kind: "critical", ring: rectangle(-75.605, 6.265, -75.599, 6.27) },
  { zoneId: zoneIdOf(7), tenantId: SUR.id, name: "Depósito Sur", kind: "depot", ring: rectangle(-75.572, 6.238, -75.566, 6.243) },
  { zoneId: zoneIdOf(8), tenantId: SUR.id, name: "Cliente Sur", kind: "customer", ring: rectangle(-75.56, 6.25, -75.555, 6.254) },
];

/** Texto WKT del polígono de una zona (`POLYGON((lng lat, ...))`): se pasa como parámetro a `ST_GeomFromText(..., 4326)`. */
export function zoneWkt(zone: SeedZone): string {
  return `POLYGON((${zone.ring.map(([lng, lat]) => `${lng} ${lat}`).join(", ")}))`;
}

/** Centro del rectángulo de una zona, en `[lng, lat]`: un punto que está dentro de ella. */
export function zoneCenter(zone: SeedZone): [number, number] {
  const lngs = zone.ring.map(([lng]) => lng);
  const lats = zone.ring.map(([, lat]) => lat);
  return [(Math.min(...lngs) + Math.max(...lngs)) / 2, (Math.min(...lats) + Math.max(...lats)) / 2];
}

export interface SeedUser {
  userId: string;
  tenantId: string;
  email: string;
  name: string;
}

/**
 * Un operador por tenant, con correo inventado del dominio reservado `.test` (RFC 2606). La contraseña NO está aquí: sale de
 * `SEED_USER_PASSWORD` y se guarda hasheada con scrypt. `f1ee7000-0000-4000-b000-<12 dígitos>` en los UUID.
 */
export const SEED_USERS: readonly SeedUser[] = [
  { userId: "f1ee7000-0000-4000-b000-000000000001", tenantId: NORTE.id, email: "operador@norte.test", name: "Operador Norte" },
  { userId: "f1ee7000-0000-4000-b000-000000000002", tenantId: SUR.id, email: "operador@sur.test", name: "Operador Sur" },
];
