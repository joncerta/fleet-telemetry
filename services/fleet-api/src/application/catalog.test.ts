import { randomUUID } from "node:crypto";
import { userListResponseSchema, vehicleCatalogItemSchema, vehicleCreateRequestSchema, vehicleListResponseSchema, type VehicleCatalogItem } from "@fleet/contracts";
import { describe, expect, it, vi } from "vitest";
import { createCreateVehicle } from "./create-vehicle.js";
import { PlateTakenError } from "./errors.js";
import { createListUsers } from "./list-users.js";
import { createListVehicles } from "./list-vehicles.js";
import type { CreateVehicleResult, TenantUserReader, VehicleCatalogRepository } from "./ports.js";

const identity = { userId: randomUUID(), tenantId: randomUUID() };
const vehicleId = randomUUID();

const stored = (plate: string, label: string | null): VehicleCatalogItem => ({ vehicleId, plate, label, hasActiveDevice: false, createdAt: "2026-10-06T12:00:00.000Z" });

function makeCatalog(result: CreateVehicleResult) {
  const create = vi.fn<VehicleCatalogRepository["create"]>(() => Promise.resolve(result));
  const list = vi.fn<VehicleCatalogRepository["list"]>(() => Promise.resolve([stored("ABC123", null)]));
  return { create, list, catalog: { create, list } satisfies VehicleCatalogRepository };
}

describe("createCreateVehicle", () => {
  it("crea el vehículo en el tenant de la SESIÓN con un id generado por el servidor y devuelve el vehículo sin dispositivo", async () => {
    const { create, catalog } = makeCatalog({ status: "created", vehicle: stored("ABC123", "Camión 7") });
    const createVehicle = createCreateVehicle({ catalog, newVehicleId: () => vehicleId });

    const vehicle = await createVehicle({ identity, vehicle: vehicleCreateRequestSchema.parse({ plate: " abc-123 ", label: " Camión 7 " }) });

    expect(vehicleCatalogItemSchema.parse(vehicle)).toEqual(stored("ABC123", "Camión 7"));
    expect(vehicle.hasActiveDevice).toBe(false);
    expect(create).toHaveBeenCalledExactlyOnceWith({ tenantId: identity.tenantId, vehicleId, plate: "ABC123", label: "Camión 7" });
  });

  it("una placa ya existente en el tenant es PlateTakenError, sin la placa en el mensaje", async () => {
    const { catalog } = makeCatalog({ status: "plate_taken" });
    const createVehicle = createCreateVehicle({ catalog, newVehicleId: () => vehicleId });

    const failure = await createVehicle({ identity, vehicle: { plate: "ABC123", label: null } }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PlateTakenError);
    expect(failure instanceof Error ? failure.message : "").not.toContain("ABC123");
  });

  it("un fallo del repositorio se propaga tal cual (no se confunde con una placa repetida)", async () => {
    const boom = new Error("conexión perdida");
    const createVehicle = createCreateVehicle({
      catalog: { create: () => Promise.reject(boom), list: vi.fn() },
      newVehicleId: () => vehicleId,
    });

    await expect(createVehicle({ identity, vehicle: { plate: "ABC123", label: null } })).rejects.toBe(boom);
  });
});

describe("createListVehicles", () => {
  it("lista el catálogo del tenant pedido con el limit, y lo devuelve en la respuesta", async () => {
    const { list, catalog } = makeCatalog({ status: "plate_taken" });

    const response = await createListVehicles({ catalog })({ tenantId: identity.tenantId, limit: 50 });

    expect(vehicleListResponseSchema.parse(response)).toEqual({ items: [stored("ABC123", null)], limit: 50 });
    expect(list).toHaveBeenCalledExactlyOnceWith(identity.tenantId, 50);
  });
});

describe("createListUsers", () => {
  it("lista los usuarios del tenant pedido con el limit", async () => {
    const user = { userId: randomUUID(), name: "Operador", email: "operador@norte.test", createdAt: "2026-10-06T12:00:00.000Z" };
    const listUsers = vi.fn<TenantUserReader["listUsers"]>(() => Promise.resolve([user]));

    const response = await createListUsers({ users: { listUsers } })({ tenantId: identity.tenantId, limit: 10 });

    expect(userListResponseSchema.parse(response)).toEqual({ items: [user] });
    expect(listUsers).toHaveBeenCalledExactlyOnceWith(identity.tenantId, 10);
  });
});
