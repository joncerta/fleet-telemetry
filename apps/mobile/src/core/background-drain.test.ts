import { describe, expect, it } from "vitest";
import { shouldDrainFromBackground } from "./background-drain";

describe("shouldDrainFromBackground", () => {
  it("el primer fix drena", () => expect(shouldDrainFromBackground(null, 1_000)).toBe(true));
  it("no drena antes de 15 s (un fix cada 5 s no manda un POST por punto)", () => {
    expect(shouldDrainFromBackground(1_000, 6_000)).toBe(false);
    expect(shouldDrainFromBackground(1_000, 11_000)).toBe(false);
    expect(shouldDrainFromBackground(1_000, 15_999)).toBe(false);
  });
  it("drena al cumplirse el intervalo", () => expect(shouldDrainFromBackground(1_000, 16_000)).toBe(true));
  it("a 5 s por fix, de 12 fixes en un minuto solo 4 drenan", () => {
    let last: number | null = null;
    let drains = 0;
    for (let t = 0; t < 60_000; t += 5_000) {
      if (shouldDrainFromBackground(last, t)) {
        drains++;
        last = t;
      }
    }
    expect(drains).toBe(4);
  });
  it("si el reloj retrocede, drena", () => expect(shouldDrainFromBackground(50_000, 10_000)).toBe(true));
  it("respeta un intervalo explícito", () => expect(shouldDrainFromBackground(0, 3_000, 2_000)).toBe(true));
});
