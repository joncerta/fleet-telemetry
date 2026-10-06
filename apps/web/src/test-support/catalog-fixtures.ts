import type { PairingCode, UserListItem, VehicleCatalogItem } from "@fleet/contracts";
import { NOW_ISO } from "./fixtures";

/** Datos de prueba INVENTADOS, válidos contra los esquemas del catálogo y de usuarios. */
let counter = 0;
const uuid = (prefix: string): string => `${prefix}-0000-4000-8000-${String(counter).padStart(12, "0")}`;

export function catalogItem(overrides: Partial<VehicleCatalogItem> = {}): VehicleCatalogItem {
  counter += 1;
  return { vehicleId: uuid("c47a1000"), plate: `TST${String(counter).padStart(3, "0")}`, label: null, hasActiveDevice: false, createdAt: NOW_ISO, ...overrides };
}

export function userItem(overrides: Partial<UserListItem> = {}): UserListItem {
  counter += 1;
  return { userId: uuid("0f9a7c1e"), name: `Usuario ${String(counter)}`, email: `usuario${String(counter)}@norte.test`, createdAt: NOW_ISO, ...overrides };
}

export const pairingCode = (vehicleId: string, overrides: Partial<PairingCode> = {}): PairingCode => ({
  code: "ABCD2345",
  vehicleId,
  expiresAt: "2026-10-06T15:10:00.000Z",
  ...overrides,
});
