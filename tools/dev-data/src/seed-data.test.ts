import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SEED_TENANTS, seedVehicles, VEHICLES_PER_TENANT } from "./seed-data.js";

describe("datos de demo", () => {
  it("define los tenants Flota Norte y Flota Sur con UUID fijos válidos para @fleet/contracts", () => {
    expect(SEED_TENANTS.map((t) => t.name)).toEqual(["Flota Norte", "Flota Sur"]);
    for (const tenant of SEED_TENANTS) expect(z.uuid().safeParse(tenant.id).success).toBe(true);
    expect(new Set(SEED_TENANTS.map((t) => t.id)).size).toBe(2);
  });

  it("siembra 15 vehículos por tenant (la fase 1b simula 30)", () => {
    const vehicles = seedVehicles();

    expect(VEHICLES_PER_TENANT).toBe(15);
    expect(vehicles).toHaveLength(30);
    for (const tenant of SEED_TENANTS) expect(vehicles.filter((v) => v.tenantId === tenant.id)).toHaveLength(15);
  });

  it("los id de vehículo son UUID válidos, únicos y estables entre corridas", () => {
    const first = seedVehicles();
    const second = seedVehicles();

    expect(first.map((v) => v.id)).toEqual(second.map((v) => v.id));
    expect(new Set(first.map((v) => v.id)).size).toBe(30);
    for (const vehicle of first) expect(z.uuid().safeParse(vehicle.id).success).toBe(true);
  });

  it("las placas son inventadas, con formato AAA999 y únicas por tenant", () => {
    const vehicles = seedVehicles();

    for (const vehicle of vehicles) expect(vehicle.plate).toMatch(/^[A-Z]{3}\d{3}$/);
    for (const tenant of SEED_TENANTS) {
      const plates = vehicles.filter((v) => v.tenantId === tenant.id).map((v) => v.plate);
      expect(new Set(plates).size).toBe(plates.length);
    }
    expect(vehicles[0]?.plate).toBe("NRT101");
  });
});
