import { describe, expect, it } from "vitest";
import { haversineMeters } from "./geo-distance.js";

describe("haversineMeters", () => {
  it("el mismo punto está a 0 m", () => {
    expect(haversineMeters({ lon: -75.5636, lat: 6.2518 }, { lon: -75.5636, lat: 6.2518 })).toBe(0);
  });

  it("un grado de latitud son unos 111,2 km", () => {
    expect(haversineMeters({ lon: -75, lat: 6 }, { lon: -75, lat: 7 })).toBeCloseTo(111_195, -2);
  });

  it("es simétrica", () => {
    const medellin = { lon: -75.5636, lat: 6.2518 };
    const bogota = { lon: -74.0721, lat: 4.711 };
    expect(haversineMeters(medellin, bogota)).toBeCloseTo(haversineMeters(bogota, medellin), 6);
  });

  it("Medellín - Bogotá: unos 240 km (la longitud va primero: con los ejes cambiados daría otra cosa)", () => {
    const distance = haversineMeters({ lon: -75.5636, lat: 6.2518 }, { lon: -74.0721, lat: 4.711 });
    expect(distance).toBeGreaterThan(235_000);
    expect(distance).toBeLessThan(245_000);
  });

  it("un desplazamiento de ~10 m (0,0001 grados de latitud, ~11,1 m) queda por debajo de 15 m", () => {
    const distance = haversineMeters({ lon: -75.5636, lat: 6.2518 }, { lon: -75.5636, lat: 6.2519 });
    expect(distance).toBeGreaterThan(10);
    expect(distance).toBeLessThan(12);
  });
});
