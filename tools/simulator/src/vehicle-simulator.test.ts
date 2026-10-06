import { telemetryPointSchema, type TelemetryPoint } from "@fleet/contracts";
import { SEED_ZONES, seedVehicles, type SeedZone } from "@fleet/dev-data";
import { describe, expect, it } from "vitest";
import { citiesOfSeedTenants, OPERATING_AREA, type City } from "./cities.js";
import { createRng } from "./rng.js";
import { createVehicleSimulator, planFleet, type VehiclePlan, type VehicleSimulator } from "./vehicle-simulator.js";

const cities = citiesOfSeedTenants();
const NOW = new Date("2026-10-06T15:00:00.000Z");
const plans = planFleet(seedVehicles(), SEED_ZONES);

function cityOf(plan: VehiclePlan): City {
  const city = cities.find((candidate) => candidate.tenantId === plan.vehicle.tenantId);
  if (city === undefined) throw new Error("falta la ciudad");
  return city;
}

function simulatorOf(plan: VehiclePlan, seed = 1, silentAfterMs = 60_000): VehicleSimulator {
  let counter = 0;
  return createVehicleSimulator({
    plan,
    city: cityOf(plan),
    rng: createRng(seed),
    startedAt: NOW,
    silentAfterMs,
    // UUID v4 válidos y distintos, deterministas.
    newEventId: () => `00000000-0000-4000-8000-${String((counter += 1)).padStart(12, "0")}`,
  });
}

const planOf = (behavior: VehiclePlan["behavior"], tenantIndex = 0): VehiclePlan => {
  const found = plans.filter((plan) => plan.behavior === behavior)[tenantIndex];
  if (found === undefined) throw new Error(`falta el plan ${behavior}`);
  return found;
};

function zoneOf(plan: VehiclePlan): SeedZone {
  if (plan.zone === undefined) throw new Error("el plan no tiene zona");
  return plan.zone;
}

function requirePoint(point: TelemetryPoint | null): TelemetryPoint {
  if (point === null) throw new Error("se esperaba un punto");
  return point;
}

/** Zona sembrada (rectángulo) que contiene el punto, en `[lon, lat]`. */
function zoneContaining(point: TelemetryPoint, zones: readonly SeedZone[]): SeedZone | undefined {
  return zones.find((zone) => {
    const lons = zone.ring.map(([lon]) => lon);
    const lats = zone.ring.map(([, lat]) => lat);
    return point.lon >= Math.min(...lons) && point.lon <= Math.max(...lons) && point.lat >= Math.min(...lats) && point.lat <= Math.max(...lats);
  });
}

describe("planFleet", () => {
  it("por tenant: 2 detenidos en zona crítica distinta, 1 simulado, 1 silencioso y el resto en movimiento", () => {
    for (const tenant of cities.map((city) => city.tenantId)) {
      const own = plans.filter((plan) => plan.vehicle.tenantId === tenant);
      expect(own).toHaveLength(15);
      expect(own.map((plan) => plan.behavior).slice(0, 5)).toEqual(["critical_stop", "critical_stop", "mocked", "silent", "moving"]);
      const zones = own.filter((plan) => plan.behavior === "critical_stop").map((plan) => plan.zone);
      expect(new Set(zones.map((zone) => zone?.zoneId)).size).toBe(2);
      expect(zones.every((zone) => zone?.kind === "critical" && zone.tenantId === tenant)).toBe(true);
      expect(own.filter((plan) => plan.behavior === "moving")).toHaveLength(11);
    }
  });
});

describe("puntos de un vehículo en movimiento", () => {
  it("cumplen telemetryPointSchema, van en [lon, lat] dentro de su ciudad y de Colombia, y recordedAt crece", () => {
    const plan = planOf("moving");
    const city = cityOf(plan);
    const simulator = simulatorOf(plan);

    const points: TelemetryPoint[] = [];
    for (let index = 1; index <= 300; index += 1) {
      const point = simulator.point(new Date(NOW.getTime() + index * 5_000));
      if (point === null) throw new Error("un vehículo en movimiento siempre envía");
      points.push(point);
    }

    for (const point of points) {
      expect(telemetryPointSchema.safeParse(point).success).toBe(true);
      expect(point.vehicleId).toBe(plan.vehicle.id);
      expect(point.mocked).toBe(false);
      // Si lon y lat estuvieran invertidas, lon (~4 a 6) quedaría fuera del rango de longitudes (~ -75).
      expect(point.lon).toBeGreaterThan(city.west - 0.001);
      expect(point.lon).toBeLessThan(city.east + 0.001);
      expect(point.lat).toBeGreaterThan(city.south - 0.001);
      expect(point.lat).toBeLessThan(city.north + 0.001);
      expect(point.lon).toBeGreaterThan(OPERATING_AREA.minLon);
      expect(point.lon).toBeLessThan(OPERATING_AREA.maxLon);
      expect(point.lat).toBeGreaterThan(OPERATING_AREA.minLat);
      expect(point.lat).toBeLessThan(OPERATING_AREA.maxLat);
      expect(point.lowAccuracy).toBe((point.accuracyM ?? 0) > 30);
    }
    const times = points.map((point) => Date.parse(point.recordedAt));
    expect(times.every((time, index) => index === 0 || time > (times[index - 1] ?? 0))).toBe(true);
    expect(new Set(points.map((point) => point.eventId)).size).toBe(points.length);
    expect(points.some((point) => (point.speedMps ?? 0) > 1)).toBe(true);
  });

  it("es reproducible con la misma semilla", () => {
    const plan = planOf("moving");
    const run = (seed: number) => {
      const simulator = simulatorOf(plan, seed);
      return Array.from({ length: 50 }, (_, index) => simulator.point(new Date(NOW.getTime() + (index + 1) * 5_000)));
    };

    expect(run(5)).toEqual(run(5));
    expect(run(5)).not.toEqual(run(6));
  });

  it("no tiene historial", () => {
    expect(simulatorOf(planOf("moving")).history(NOW)).toEqual([]);
  });
});

describe("vehículo detenido en una zona crítica", () => {
  it.each([0, 1, 2, 3])("el historial (caso %i) arranca la parada entre 25 y 30 minutos atrás, dentro de la zona y de menos de 500 puntos", (index) => {
    const plan = planOf("critical_stop", index);
    const history = simulatorOf(plan, index + 1).history(NOW);

    expect(history.length).toBeGreaterThan(20);
    expect(history.length).toBeLessThan(500);
    for (const point of history) expect(telemetryPointSchema.safeParse(point).success).toBe(true);
    const times = history.map((point) => Date.parse(point.recordedAt));
    expect(times.every((time, position) => position === 0 || time > (times[position - 1] ?? 0))).toBe(true);
    expect(times.every((time) => time < NOW.getTime())).toBe(true);

    const stopped = history.filter((point) => point.speedMps === 0);
    const stopStartedMinutesAgo = (NOW.getTime() - Date.parse(stopped[0]?.recordedAt ?? "")) / 60_000;
    expect(stopStartedMinutesAgo).toBeGreaterThanOrEqual(25);
    expect(stopStartedMinutesAgo).toBeLessThanOrEqual(30);
    // El primer punto es de aproximación (en movimiento) y todos los demás están detenidos, dentro de la zona crítica asignada.
    expect(history[0]?.speedMps).toBeGreaterThan(0.5);
    expect(history.slice(3).every((point) => point.speedMps === 0)).toBe(true);
    for (const point of stopped) expect(zoneContaining(point, [zoneOf(plan)])).toBeDefined();
  });

  it("los puntos en vivo siguen detenidos en la misma zona, con recordedAt creciente", () => {
    const plan = planOf("critical_stop");
    const simulator = simulatorOf(plan);

    const live = Array.from({ length: 20 }, (_, index) => simulator.point(new Date(NOW.getTime() + (index + 1) * 5_000)));

    for (const point of live) {
      expect(point).not.toBeNull();
      expect(point?.speedMps).toBe(0);
      expect(point?.mocked).toBe(false);
      expect(zoneContaining(requirePoint(point), [zoneOf(plan)])?.kind).toBe("critical");
    }
  });
});

describe("vehículo con ubicación simulada", () => {
  it("todos sus puntos llevan mocked: true y se mueve", () => {
    const simulator = simulatorOf(planOf("mocked"));

    const points = Array.from({ length: 40 }, (_, index) => simulator.point(new Date(NOW.getTime() + (index + 1) * 5_000)));

    expect(points.every((point) => point?.mocked === true)).toBe(true);
    expect(points.some((point) => (point?.speedMps ?? 0) > 1)).toBe(true);
  });
});

describe("vehículo que deja de enviar", () => {
  it("envía hasta silentAfterMs desde el arranque y después devuelve null", () => {
    const simulator = simulatorOf(planOf("silent"), 1, 60_000);

    expect(simulator.point(new Date(NOW.getTime() + 5_000))).not.toBeNull();
    expect(simulator.point(new Date(NOW.getTime() + 59_000))).not.toBeNull();
    expect(simulator.point(new Date(NOW.getTime() + 60_000))).toBeNull();
    expect(simulator.point(new Date(NOW.getTime() + 300_000))).toBeNull();
  });
});
