import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  COLOMBIA_BBOX,
  planFleet,
  planZones,
  ringToWkt,
  ticksPerDay,
  totalRows,
  VehicleSimulator,
  vehicleDay,
  type FinalVehicleState,
  type GeneratorConfig,
  type SyntheticPoint,
} from "./fleet-generator.js";

const config: GeneratorConfig = { seed: 42, vehicles: 6, days: 2, intervalSeconds: 30, endAt: new Date("2026-10-01T00:00:00.000Z") };

function pointsOf(cfg: GeneratorConfig, vehicleIndex: number): SyntheticPoint[] {
  const vehicle = planFleet(cfg).vehicles[vehicleIndex];
  if (vehicle === undefined) throw new Error("sin vehículo");
  const sim = new VehicleSimulator(vehicle, cfg.seed, cfg.intervalSeconds);
  return Array.from({ length: cfg.days }, (_, day) => [...vehicleDay(sim, cfg, day)]).flat();
}

describe("planFleet", () => {
  it("es determinista por semilla y cambia con otra", () => {
    expect(planFleet(config)).toEqual(planFleet(config));
    expect(planFleet({ ...config, seed: 43 }).vehicles[0]?.id).not.toBe(planFleet(config).vehicles[0]?.id);
  });

  it("reparte los vehículos en 2 tenants con UUID válidos y placas únicas", () => {
    const plan = planFleet(config);

    expect(plan.tenants).toHaveLength(2);
    expect(new Set(plan.vehicles.map((v) => v.tenantId))).toEqual(new Set(plan.tenants.map((t) => t.id)));
    for (const v of plan.vehicles) {
      expect(z.uuid().safeParse(v.id).success).toBe(true);
      expect(z.uuid().safeParse(v.deviceId).success).toBe(true);
    }
    expect(new Set(plan.vehicles.map((v) => v.plate)).size).toBe(config.vehicles);
  });
});

describe("VehicleSimulator", () => {
  it("genera los mismos puntos con la misma semilla", () => {
    expect(pointsOf(config, 0)).toEqual(pointsOf(config, 0));
    expect(pointsOf({ ...config, seed: 7 }, 0)[10]?.lon).not.toBe(pointsOf(config, 0)[10]?.lon);
  });

  it("produce días × puntos por día, en orden cronológico y con eventId únicos", () => {
    const points = pointsOf(config, 1);

    expect(points).toHaveLength(config.days * ticksPerDay(30));
    expect(totalRows(config)).toBe(config.vehicles * points.length);
    for (let i = 1; i < points.length; i += 1) {
      expect(points[i]?.recordedAt.getTime()).toBe((points[i - 1]?.recordedAt.getTime() ?? 0) + 30_000);
    }
    expect(new Set(points.map((p) => p.eventId)).size).toBe(points.length);
    expect(points.every((p) => z.uuid().safeParse(p.eventId).success)).toBe(true);
    expect(points.at(-1)?.recordedAt.getTime()).toBeLessThan(config.endAt.getTime());
  });

  it("todos los puntos caen en Colombia con [lon, lat] (la longitud es la negativa)", () => {
    // Un solo expect sobre los puntos fuera del área: cinco por punto (~35 000 puntos) superaban el timeout en el runner de CI.
    const outside: { vehicle: number; lon: number; lat: number }[] = [];
    for (let v = 0; v < config.vehicles; v += 1) {
      for (const p of pointsOf(config, v)) {
        const inside =
          p.lon >= COLOMBIA_BBOX.minLon && p.lon <= COLOMBIA_BBOX.maxLon && p.lat >= COLOMBIA_BBOX.minLat && p.lat <= COLOMBIA_BBOX.maxLat && p.lon < 0;
        if (!inside) outside.push({ vehicle: v, lon: p.lon, lat: p.lat });
      }
    }
    expect(outside).toEqual([]);
  });

  it("alterna movimiento y detenciones, y recibe después de grabar", () => {
    const points = pointsOf({ ...config, days: 1 }, 0);

    expect(points.some((p) => p.speedMps === 0)).toBe(true);
    expect(points.some((p) => (p.speedMps ?? 0) > 0)).toBe(true);
    expect(points.every((p) => p.receivedAt.getTime() > p.recordedAt.getTime())).toBe(true);
  });
});

describe("planZones", () => {
  const cfg = { ...config, vehicles: 40, days: 1 };
  const plan = planFleet(cfg);
  const finals: FinalVehicleState[] = plan.vehicles.flatMap((vehicle) => {
    const sim = new VehicleSimulator(vehicle, cfg.seed, cfg.intervalSeconds);
    for (let day = 0; day < cfg.days; day += 1) Array.from(vehicleDay(sim, cfg, day));
    const final = sim.finalState();
    return final === null ? [] : [final];
  });

  it("es determinista, con nombres únicos por tenant y anillos cerrados dentro de Colombia en [lon, lat]", () => {
    const zones = planZones(cfg, plan.tenants, finals, 50);

    expect(zones).toEqual(planZones(cfg, plan.tenants, finals, 50));
    expect(zones).toHaveLength(100);
    for (const tenant of plan.tenants) {
      const names = zones.filter((zone) => zone.tenantId === tenant.id).map((zone) => zone.name);
      expect(new Set(names).size).toBe(50);
    }
    for (const zone of zones) {
      expect(zone.ring[0]).toEqual(zone.ring.at(-1));
      for (const [lon, lat] of zone.ring) {
        expect(lon).toBeGreaterThanOrEqual(COLOMBIA_BBOX.minLon);
        expect(lon).toBeLessThanOrEqual(COLOMBIA_BBOX.maxLon);
        expect(lat).toBeGreaterThanOrEqual(COLOMBIA_BBOX.minLat);
        expect(lat).toBeLessThanOrEqual(COLOMBIA_BBOX.maxLat);
      }
    }
  });

  it("ancla zonas críticas sobre vehículos detenidos", () => {
    const stopped = finals.filter((f) => f.movement === "stopped");
    const zones = planZones(cfg, plan.tenants, finals, 50);

    expect(stopped.length).toBeGreaterThan(0);
    const first = stopped[0];
    expect(zones.some((zone) => zone.kind === "critical" && zone.ring.some(([lon]) => Math.abs(lon - (first?.point.lon ?? 0)) < 0.01))).toBe(true);
  });

  it("el WKT pone la longitud primero", () => {
    expect(
      ringToWkt([
        [-74.1, 4.6],
        [-74.0, 4.6],
        [-74.0, 4.7],
        [-74.1, 4.6],
      ]),
    ).toBe("POLYGON((-74.1 4.6, -74 4.6, -74 4.7, -74.1 4.6))");
  });
});
