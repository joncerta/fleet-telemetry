import { describe, expect, it } from "vitest";
import { COLOMBIA_BBOX, isInsideOperatingArea } from "./operating-area.js";

describe("isInsideOperatingArea", () => {
  it.each([
    ["Medellín", -75.5636, 6.2518],
    ["Bogotá", -74.0721, 4.711],
    ["Leticia (extremo sur)", -69.9406, -4.2153],
    ["Punta Gallinas (extremo norte continental)", -71.6667, 12.4583],
    ["San Andrés", -81.7003, 12.5847],
    ["Providencia", -81.3711, 13.3492],
    ["cayo Roncador", -80.0537, 13.5667],
  ])("%s está dentro", (_name, lon, lat) => {
    expect(isInsideOperatingArea(lon, lat)).toBe(true);
  });

  it.each([
    ["Madrid", -3.7038, 40.4168],
    ["Miami", -80.1918, 25.7617],
    ["David (Panamá, al occidente del rectángulo)", -82.4333, 8.4333],
    ["Bocas del Toro (Panamá)", -82.24, 9.34],
    ["Lima (lat -12, al sur del rectángulo)", -77.0428, -12.0464],
    ["0,0 (GPS sin fix)", 0, 0],
    ["lon y lat intercambiadas (Medellín al revés)", 6.2518, -75.5636],
    ["cayo Serrana (lat 14,27)", -80.3, 14.27],
  ])("%s está fuera", (_name, lon, lat) => {
    expect(isInsideOperatingArea(lon, lat)).toBe(false);
  });

  describe("bordes del rectángulo (incluidos) y un paso más allá (excluido)", () => {
    const { minLon, maxLon, minLat, maxLat } = COLOMBIA_BBOX;
    const midLon = (minLon + maxLon) / 2;
    const midLat = (minLat + maxLat) / 2;
    const EPSILON = 1e-6;

    it("las cuatro esquinas están dentro", () => {
      for (const lon of [minLon, maxLon]) for (const lat of [minLat, maxLat]) expect(isInsideOperatingArea(lon, lat)).toBe(true);
    });

    it("cada borde está dentro y un poco más allá está fuera", () => {
      expect(isInsideOperatingArea(minLon, midLat)).toBe(true);
      expect(isInsideOperatingArea(minLon - EPSILON, midLat)).toBe(false);
      expect(isInsideOperatingArea(maxLon, midLat)).toBe(true);
      expect(isInsideOperatingArea(maxLon + EPSILON, midLat)).toBe(false);
      expect(isInsideOperatingArea(midLon, minLat)).toBe(true);
      expect(isInsideOperatingArea(midLon, minLat - EPSILON)).toBe(false);
      expect(isInsideOperatingArea(midLon, maxLat)).toBe(true);
      expect(isInsideOperatingArea(midLon, maxLat + EPSILON)).toBe(false);
    });
  });

  it("incluye San Andrés y Providencia: el límite occidental queda al oeste de los cayos de Albuquerque (lon -81,85)", () => {
    expect(COLOMBIA_BBOX.minLon).toBeLessThan(-81.85);
  });

  it("es un rectángulo, no un polígono: Ciudad de Panamá cae dentro (límite conocido y documentado)", () => {
    // Si algún día se afina con un polígono, este test debe cambiar a `false` junto con la decisión.
    expect(isInsideOperatingArea(-79.5199, 8.9824)).toBe(true);
  });

  it("acepta otra área como argumento", () => {
    const area = { minLon: 0, maxLon: 1, minLat: 0, maxLat: 1 };

    expect(isInsideOperatingArea(0.5, 0.5, area)).toBe(true);
    expect(isInsideOperatingArea(-75.5636, 6.2518, area)).toBe(false);
  });
});
