import { describe, expect, it, vi } from "vitest";
import { TtlCache } from "./ttl-cache.js";

function setup(options: { ttlMs?: number; maxEntries?: number } = {}) {
  let now = 1_000;
  const cache = new TtlCache<string | null>({ ttlMs: options.ttlMs ?? 100, maxEntries: options.maxEntries ?? 3, now: () => now });
  return { cache, advance: (ms: number) => void (now += ms) };
}

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

describe("TtlCache", () => {
  it("devuelve lo guardado mientras esté vigente, y distingue un valor null de una clave ausente", () => {
    const { cache } = setup();

    cache.set("a", "uno");
    cache.set("n", null);

    expect(cache.get("a")).toEqual({ value: "uno" });
    expect(cache.get("n")).toEqual({ value: null });
    expect(cache.get("ausente")).toBeUndefined();
  });

  it("una entrada vence exactamente a los ttlMs y se descarta al leerla", () => {
    const { cache, advance } = setup({ ttlMs: 100 });
    cache.set("a", "uno");

    advance(99);
    expect(cache.get("a")).toEqual({ value: "uno" });
    advance(1);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("leer no renueva el vencimiento", () => {
    const { cache, advance } = setup({ ttlMs: 100 });
    cache.set("a", "uno");
    advance(60);
    cache.get("a");
    advance(60);

    expect(cache.get("a")).toBeUndefined();
  });

  it("volver a guardar una clave renueva su vencimiento", () => {
    const { cache, advance } = setup({ ttlMs: 100 });
    cache.set("a", "uno");
    advance(80);
    cache.set("a", "dos");
    advance(80);

    expect(cache.get("a")).toEqual({ value: "dos" });
  });

  it("nunca supera maxEntries: al llenarse descarta primero las vencidas y luego la más antigua", () => {
    const { cache, advance } = setup({ ttlMs: 100, maxEntries: 3 });
    cache.set("a", "1");
    advance(50);
    cache.set("b", "2");
    cache.set("c", "3");

    cache.set("d", "4"); // lleno, ninguna vencida: sale la más antigua (a)
    expect(cache.size).toBe(3);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toEqual({ value: "2" });

    cache.set("e", "5"); // otra vez lleno: sale b, ahora la más antigua
    expect(cache.size).toBe(3);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("e")).toEqual({ value: "5" });
  });

  it("al llenarse prefiere liberar las entradas vencidas antes que expulsar una vigente", () => {
    const { cache, advance } = setup({ ttlMs: 100, maxEntries: 2 });
    cache.set("viejo", "1");
    advance(90);
    cache.set("reciente", "2");
    advance(20); // viejo venció; reciente sigue vigente

    cache.set("nuevo", "3");

    expect(cache.get("reciente")).toEqual({ value: "2" });
    expect(cache.get("nuevo")).toEqual({ value: "3" });
    expect(cache.size).toBe(2);
  });

  it("con ttl 0 queda desactivada: nada llega a estar vigente", () => {
    const { cache } = setup({ ttlMs: 0 });

    cache.set("a", "uno");

    expect(cache.get("a")).toBeUndefined();
  });

  it("rechaza una configuración inválida", () => {
    expect(() => new TtlCache({ ttlMs: 10, maxEntries: 0 })).toThrow(RangeError);
    expect(() => new TtlCache({ ttlMs: -1, maxEntries: 1 })).toThrow(RangeError);
  });
  it("con la caché llena de entradas vigentes, al desalojar no recorre toda la caché: se corta en la primera vigente", () => {
    const { cache } = setup({ ttlMs: 100, maxEntries: 2_000 });
    for (let i = 0; i < 2_000; i += 1) cache.set(`vigente-${i}`, "x");

    const steps = countMapIterationSteps(() => {
      for (let i = 0; i < 100; i += 1) cache.set(`nueva-${i}`, "y");
    });

    expect(steps).toBeLessThanOrEqual(200);
    expect(cache.size).toBe(2_000);
  });

  it("al desalojar libera todas las vencidas del principio y respeta el orden de vencimiento", () => {
    const { cache, advance } = setup({ ttlMs: 100, maxEntries: 4 });
    cache.set("a", "1");
    cache.set("b", "2");
    advance(60);
    cache.set("c", "3");
    cache.set("d", "4");
    advance(50); // a y b vencieron; c y d no

    cache.set("e", "5");

    expect(cache.size).toBe(3);
    expect(cache.get("c")).toEqual({ value: "3" });
    expect(cache.get("d")).toEqual({ value: "4" });
    expect(cache.get("e")).toEqual({ value: "5" });
  });
});
