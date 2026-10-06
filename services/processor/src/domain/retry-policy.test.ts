import { describe, expect, it } from "vitest";
import { backoffDelayMs } from "./retry-policy.js";

const policy = { initialDelayMs: 100, maxDelayMs: 1_000 };

describe("backoffDelayMs", () => {
  it("el techo se duplica en cada reintento: 100, 200, 400, 800 (con random casi 1)", () => {
    const ceilings = [1, 2, 3, 4].map((n) => backoffDelayMs(n, policy, 0.999999));

    expect(ceilings).toEqual([100, 200, 400, 800]);
  });

  it("no pasa del tope aunque el exponente crezca", () => {
    expect(backoffDelayMs(5, policy, 0.999999)).toBe(1_000);
    expect(backoffDelayMs(50, policy, 0.999999)).toBe(1_000);
    expect(backoffDelayMs(5_000, policy, 0.999999)).toBe(1_000);
  });

  it("el jitter reparte la espera entre la mitad del techo y el techo", () => {
    expect(backoffDelayMs(3, policy, 0)).toBe(200);
    expect(backoffDelayMs(3, policy, 0.5)).toBe(300);
    expect(backoffDelayMs(3, policy, 0.999999)).toBe(400);
  });

  it("dos valores de random distintos dan esperas distintas (las réplicas no reintentan en bloque)", () => {
    expect(backoffDelayMs(2, policy, 0.1)).not.toBe(backoffDelayMs(2, policy, 0.9));
  });

  it("con el tope por debajo del inicial, el tope manda", () => {
    expect(backoffDelayMs(1, { initialDelayMs: 500, maxDelayMs: 100 }, 0.999999)).toBe(100);
  });
});
