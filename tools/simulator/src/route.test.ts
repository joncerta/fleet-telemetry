import { describe, expect, it } from "vitest";
import { citiesOfSeedTenants, OPERATING_AREA } from "./cities.js";
import { createRng } from "./rng.js";
import { createRouteWalker } from "./route.js";

const cities = citiesOfSeedTenants();

function walk(cityIndex: number, seed: number, steps: number, stepM: number) {
  const city = cities[cityIndex];
  if (city === undefined) throw new Error("falta la ciudad");
  const walker = createRouteWalker(city, createRng(seed));
  const positions = [walker.position()];
  for (let step = 0; step < steps; step += 1) {
    walker.advance(stepM);
    positions.push(walker.position());
  }
  return { city, positions };
}

describe("createRouteWalker", () => {
  it("es reproducible: la misma semilla da el mismo recorrido y otra semilla, otro", () => {
    expect(walk(0, 7, 200, 40).positions).toEqual(walk(0, 7, 200, 40).positions);
    expect(walk(0, 7, 200, 40).positions).not.toEqual(walk(0, 8, 200, 40).positions);
  });

  it.each([0, 1])("nunca sale de su ciudad ni de Colombia, con varias semillas, y el orden es [lon, lat] (ciudad %i)", (cityIndex) => {
    for (let seed = 1; seed <= 25; seed += 1) {
      const { city, positions } = walk(cityIndex, seed, 400, 55);
      for (const { lon, lat } of positions) {
        expect(lon).toBeGreaterThanOrEqual(city.west - 1e-9);
        expect(lon).toBeLessThanOrEqual(city.east + 1e-9);
        expect(lat).toBeGreaterThanOrEqual(city.south - 1e-9);
        expect(lat).toBeLessThanOrEqual(city.north + 1e-9);
        expect(lon).toBeGreaterThan(OPERATING_AREA.minLon);
        expect(lon).toBeLessThan(OPERATING_AREA.maxLon);
        expect(lat).toBeGreaterThan(OPERATING_AREA.minLat);
        expect(lat).toBeLessThan(OPERATING_AREA.maxLat);
      }
    }
  });

  it("las ciudades están en Colombia y con la longitud primero: Bogotá y Medellín tienen lon negativa y lat de 4 a 7", () => {
    for (const city of cities) {
      expect(city.west).toBeLessThan(-70);
      expect(city.north).toBeGreaterThan(4);
      expect(city.north).toBeLessThan(7);
    }
  });

  it("se mueve de verdad, con rumbos válidos, gira y cruza esquinas", () => {
    const { positions } = walk(0, 3, 300, 55);
    const headings = new Set(positions.map((position) => position.headingDeg));

    expect([...headings].every((heading) => [0, 90, 180, 270].includes(heading))).toBe(true);
    expect(headings.size).toBeGreaterThan(1);
    expect(new Set(positions.map((position) => `${position.lon}|${position.lat}`)).size).toBeGreaterThan(250);
  });

  it("advance devuelve las esquinas cruzadas y no avanza con distancia 0 o negativa", () => {
    const city = cities[0];
    if (city === undefined) throw new Error("falta la ciudad");
    const walker = createRouteWalker(city, createRng(1));
    const before = walker.position();

    expect(walker.advance(0)).toBe(0);
    expect(walker.advance(-50)).toBe(0);
    expect(walker.position()).toEqual(before);
    expect(walker.advance(1_000)).toBeGreaterThanOrEqual(7);
  });
});
