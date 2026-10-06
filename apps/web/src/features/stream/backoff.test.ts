import { describe, expect, it } from "vitest";
import { backoffDelayMs, STREAM_BACKOFF } from "./backoff";

describe("backoffDelayMs", () => {
  it("crece exponencialmente entre la mitad y el total del tope de cada intento", () => {
    expect(backoffDelayMs(0, () => 0)).toBe(1_000);
    expect(backoffDelayMs(1, () => 0)).toBe(1_000);
    expect(backoffDelayMs(1, () => 0.999_999)).toBe(2_000);
    expect(backoffDelayMs(3, () => 0)).toBe(4_000);
    expect(backoffDelayMs(3, () => 0.5)).toBe(6_000);
  });

  it("nunca baja de 1 s ni pasa de 30 s", () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      for (const random of [0, 0.5, 0.999_999]) {
        const delay = backoffDelayMs(attempt, () => random);
        expect(delay).toBeGreaterThanOrEqual(STREAM_BACKOFF.initialMs);
        expect(delay).toBeLessThanOrEqual(STREAM_BACKOFF.maxMs);
      }
    }
    expect(backoffDelayMs(10, () => 0)).toBe(15_000);
  });
});
