import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFixedWindowFailureCounter } from "./fixed-window-failure-counter.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-14T20:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Cuenta los elementos que recorren los `for...of` sobre un `Map` mientras corre `run`. Sirve para probar que la purga no
 * recorre todo el mapa (O(n) por inserción) sin depender de tiempos.
 */
function countMapIterationSteps(run: () => void): number {
  const original = Map.prototype[Symbol.iterator];
  let steps = 0;
  const spy = vi.spyOn(Map.prototype, Symbol.iterator).mockImplementation(function (this: Map<unknown, unknown>) {
    const inner = original.call(this);
    const next = inner.next.bind(inner);
    inner.next = () => {
      const result = next();
      if (result.done !== true) steps += 1;
      return result;
    };
    return inner;
  });
  try {
    run();
  } finally {
    spy.mockRestore();
  }
  return steps;
}

describe("createFixedWindowFailureCounter", () => {
  it("no bloquea una key sin fallos", () => {
    const counter = createFixedWindowFailureCounter({ max: 2, timeWindowMs: 60_000 });

    expect(counter.check("203.0.113.1")).toEqual({ blocked: false });
  });

  it("bloquea la key cuando acumula max fallos, no antes", () => {
    const counter = createFixedWindowFailureCounter({ max: 2, timeWindowMs: 60_000 });

    counter.recordFailure("203.0.113.1");
    expect(counter.check("203.0.113.1").blocked).toBe(false);
    counter.recordFailure("203.0.113.1");

    expect(counter.check("203.0.113.1").blocked).toBe(true);
  });

  it("consultar no cuenta: muchas consultas sin fallos nunca bloquean", () => {
    const counter = createFixedWindowFailureCounter({ max: 1, timeWindowMs: 60_000 });

    for (let i = 0; i < 50; i += 1) counter.check("203.0.113.1");

    expect(counter.check("203.0.113.1").blocked).toBe(false);
  });

  it("cada key tiene su propio contador", () => {
    const counter = createFixedWindowFailureCounter({ max: 1, timeWindowMs: 60_000 });

    counter.recordFailure("203.0.113.1");

    expect(counter.check("203.0.113.1").blocked).toBe(true);
    expect(counter.check("203.0.113.2").blocked).toBe(false);
  });

  it("informa los segundos que faltan para que termine la ventana, redondeados hacia arriba y nunca menos de 1", () => {
    const counter = createFixedWindowFailureCounter({ max: 1, timeWindowMs: 60_000 });
    counter.recordFailure("k");

    expect(counter.check("k")).toEqual({ blocked: true, retryAfterSeconds: 60 });
    vi.advanceTimersByTime(30_001);
    expect(counter.check("k")).toEqual({ blocked: true, retryAfterSeconds: 30 });
    vi.advanceTimersByTime(29_500);
    expect(counter.check("k")).toEqual({ blocked: true, retryAfterSeconds: 1 });
  });

  it("al terminar la ventana la key se desbloquea y el conteo empieza de cero", () => {
    const counter = createFixedWindowFailureCounter({ max: 2, timeWindowMs: 60_000 });
    counter.recordFailure("k");
    counter.recordFailure("k");
    expect(counter.check("k").blocked).toBe(true);

    vi.advanceTimersByTime(60_000);

    expect(counter.check("k").blocked).toBe(false);
    counter.recordFailure("k");
    expect(counter.check("k").blocked).toBe(false);
  });

  it("los fallos de una ventana vencida no se suman a los de la nueva", () => {
    const counter = createFixedWindowFailureCounter({ max: 2, timeWindowMs: 1_000 });
    counter.recordFailure("k");
    vi.advanceTimersByTime(1_000);

    counter.recordFailure("k");

    expect(counter.check("k").blocked).toBe(false);
  });

  it("la ventana no se renueva con cada fallo: es fija desde el primero", () => {
    const counter = createFixedWindowFailureCounter({ max: 3, timeWindowMs: 60_000 });
    counter.recordFailure("k");
    vi.advanceTimersByTime(40_000);
    counter.recordFailure("k");
    counter.recordFailure("k");

    expect(counter.check("k")).toEqual({ blocked: true, retryAfterSeconds: 20 });
  });

  it("la memoria está acotada: con más keys que maxKeys descarta primero las vencidas y después las más viejas", () => {
    const counter = createFixedWindowFailureCounter({ max: 1, timeWindowMs: 1_000, maxKeys: 3 });
    counter.recordFailure("a");
    vi.advanceTimersByTime(1_000);
    counter.recordFailure("b");
    counter.recordFailure("c");
    counter.recordFailure("d");

    expect(counter.size()).toBeLessThanOrEqual(3);
    expect(counter.check("d").blocked).toBe(true);

    counter.recordFailure("e");
    expect(counter.size()).toBeLessThanOrEqual(3);
    expect(counter.check("e").blocked).toBe(true);
    expect(counter.check("b").blocked).toBe(false);
  });
  it("con el mapa lleno de ventanas vigentes, la purga no recorre el mapa entero: se corta en la primera vigente", () => {
    const counter = createFixedWindowFailureCounter({ max: 1, timeWindowMs: 60_000, maxKeys: 2_000 });
    for (let i = 0; i < 2_000; i += 1) counter.recordFailure(`vigente-${i}`);

    const steps = countMapIterationSteps(() => {
      for (let i = 0; i < 100; i += 1) counter.recordFailure(`nueva-${i}`);
    });

    // 100 inserciones con el mapa lleno: a lo sumo una mirada a la ventana más antigua por inserción (no 2 000 por inserción).
    expect(steps).toBeLessThanOrEqual(200);
    expect(counter.size()).toBe(2_000);
  });

  it("la purga descarta las ventanas vencidas del principio y deja las vigentes", () => {
    const counter = createFixedWindowFailureCounter({ max: 1, timeWindowMs: 1_000, maxKeys: 4 });
    counter.recordFailure("a");
    counter.recordFailure("b");
    vi.advanceTimersByTime(500);
    counter.recordFailure("c");
    counter.recordFailure("d");
    vi.advanceTimersByTime(600); // a y b vencieron; c y d siguen vigentes

    counter.recordFailure("e");

    expect(counter.size()).toBe(3);
    expect(counter.check("c").blocked).toBe(true);
    expect(counter.check("d").blocked).toBe(true);
  });
});
