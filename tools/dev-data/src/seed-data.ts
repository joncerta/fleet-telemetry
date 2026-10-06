/**
 * Datos de demo (solo local). Los UUID son fijos y de versión 4 con variante RFC 4122, para que pasen `z.uuid()` de
 * `@fleet/contracts`: el simulador de la fase 1b los usa como `vehicleId` y el seed es idempotente por `id`.
 * Las placas son inventadas; no corresponden a vehículos reales.
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

export const SEED_TENANTS: readonly SeedTenant[] = [
  { id: "f1ee7000-0000-4000-8000-000000000001", name: "Flota Norte", platePrefix: "NRT", vehicleIdBase: 1_000 },
  { id: "f1ee7000-0000-4000-8000-000000000002", name: "Flota Sur", platePrefix: "SUR", vehicleIdBase: 2_000 },
];

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
