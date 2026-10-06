import { describe, expect, it } from "vitest";
import { backoffDelayMs, STREAM_BACKOFF } from "./backoff";

describe("backoffDelayMs", () => {
  it("el intento 0 ya tiene jitter: entre 1 s y 2 s (las pestañas no reconectan todas a la vez)", () => {
    expect(backoffDelayMs(0, () => 0)).toBe(1_000);
    expect(backoffDelayMs(0, () => 0.999_999)).toBeGreaterThan(1_900);
    expect(backoffDelayMs(0, () => 0.5)).toBe(1_500);
  });

  it("crece exponencialmente: el tope del intento se duplica y el jitter va de 1 s al tope", () => {
    expect(backoffDelayMs(1, () => 0)).toBe(1_000);
    expect(backoffDelayMs(1, () => 0.999_999)).toBe(4_000);
    expect(backoffDelayMs(2, () => 0.999_999)).toBe(8_000);
    expect(backoffDelayMs(3, () => 0.5)).toBe(8_500);
  });

  it("nunca baja de 1 s ni pasa de 30 s", () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      for (const random of [0, 0.5, 0.999_999]) {
        const delay = backoffDelayMs(attempt, () => random);
        expect(delay).toBeGreaterThanOrEqual(STREAM_BACKOFF.initialMs);
        expect(delay).toBeLessThanOrEqual(STREAM_BACKOFF.maxMs);
      }
    }
    expect(backoffDelayMs(10, () => 0.999_999)).toBe(30_000);
  });
});
