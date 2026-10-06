import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SEED_TENANTS, SEED_USERS, SEED_ZONES, seedVehicles, VEHICLES_PER_TENANT, zoneCenter, zoneWkt } from "./seed-data.js";

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

describe("zonas de demo", () => {
  it("cada tenant tiene 2 críticas, 1 depósito y 1 cliente", () => {
    for (const tenant of SEED_TENANTS) {
      const kinds = SEED_ZONES.filter((z) => z.tenantId === tenant.id).map((z) => z.kind);
      expect(kinds.sort()).toEqual(["critical", "critical", "customer", "depot"]);
    }
    expect(SEED_ZONES).toHaveLength(8);
  });

  it("los id son UUID válidos y únicos, y los nombres son únicos dentro de cada tenant", () => {
    expect(new Set(SEED_ZONES.map((z) => z.zoneId)).size).toBe(SEED_ZONES.length);
    for (const zone of SEED_ZONES) expect(z.uuid().safeParse(zone.zoneId).success).toBe(true);
    for (const tenant of SEED_TENANTS) {
      const names = SEED_ZONES.filter((zone) => zone.tenantId === tenant.id).map((zone) => zone.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it("los anillos están cerrados y en [lng, lat]: dentro del área de operación (Colombia) y NO invertidos", () => {
    for (const zone of SEED_ZONES) {
      expect(zone.ring.length).toBeGreaterThanOrEqual(4);
      expect(zone.ring[0]).toEqual(zone.ring.at(-1));
      for (const [lng, lat] of zone.ring) {
        // Longitud de Colombia: de -82 a -66,8 (negativa). Si estuvieran invertidos, "lng" valdría ~5 y quedaría fuera.
        expect(lng).toBeGreaterThanOrEqual(-82);
        expect(lng).toBeLessThanOrEqual(-66.8);
        expect(lat).toBeGreaterThanOrEqual(-4.3);
        expect(lat).toBeLessThanOrEqual(13.6);
      }
    }
  });

  it("las zonas de un mismo tenant no se solapan", () => {
    const boxOf = (zone: (typeof SEED_ZONES)[number]) => ({
      west: Math.min(...zone.ring.map(([lng]) => lng)),
      east: Math.max(...zone.ring.map(([lng]) => lng)),
      south: Math.min(...zone.ring.map(([, lat]) => lat)),
      north: Math.max(...zone.ring.map(([, lat]) => lat)),
    });
    for (const tenant of SEED_TENANTS) {
      const boxes = SEED_ZONES.filter((zone) => zone.tenantId === tenant.id).map(boxOf);
      for (const [i, a] of boxes.entries()) {
        for (const b of boxes.slice(i + 1)) {
          const overlaps = a.west < b.east && b.west < a.east && a.south < b.north && b.south < a.north;
          expect(overlaps).toBe(false);
        }
      }
    }
  });

  it("zoneWkt escribe la longitud primero y cierra el polígono; zoneCenter cae dentro", () => {
    const [first] = SEED_ZONES;
    expect(first).toBeDefined();
    if (first === undefined) return;

    expect(zoneWkt(first)).toBe("POLYGON((-74.0905 4.724, -74.0845 4.724, -74.0845 4.729, -74.0905 4.729, -74.0905 4.724))");
    const [lng, lat] = zoneCenter(first);
    expect(lng).toBeCloseTo(-74.0875, 6);
    expect(lat).toBeCloseTo(4.7265, 6);
  });
});

describe("usuarios de demo", () => {
  it("hay uno por tenant, con correo inventado del dominio .test y UUID válidos y únicos", () => {
    expect(SEED_USERS.map((u) => u.email)).toEqual(["operador@norte.test", "operador@sur.test"]);
    expect(SEED_USERS.map((u) => u.tenantId)).toEqual(SEED_TENANTS.map((t) => t.id));
    expect(new Set(SEED_USERS.map((u) => u.userId)).size).toBe(2);
    for (const user of SEED_USERS) {
      expect(z.uuid().safeParse(user.userId).success).toBe(true);
      expect(z.email().safeParse(user.email).success).toBe(true);
      expect(user.email.endsWith(".test")).toBe(true);
    }
  });

  it("no llevan contraseña: sale de SEED_USER_PASSWORD", () => {
    for (const user of SEED_USERS) expect(Object.keys(user).sort()).toEqual(["email", "name", "tenantId", "userId"]);
  });
});
