import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backoffDelayMs, delayWithRetryAfter, parseRetryAfter } from "./backoff";
import { http, makePoint, setup } from "./test-helpers";

describe("backoffDelayMs", () => {
  it("el techo crece de forma exponencial y se queda en el máximo de 60 s", () => {
    const ceilings = [0, 1, 2, 3, 4, 5, 6, 10, 50].map((n) => backoffDelayMs(n, () => 0.999999));
    expect(ceilings.slice(0, 4)).toEqual([1999, 3999, 7999, 15999]);
    expect(ceilings[4]).toBeGreaterThan(ceilings[3]!);
    expect(Math.max(...ceilings)).toBeLessThanOrEqual(60_000);
    expect(ceilings.slice(-3).every((v) => v >= 59_000 && v <= 60_000)).toBe(true);
  });

  it("nunca baja del mínimo de 1 s (sin loop apretado)", () => {
    for (let n = 0; n < 10; n++) expect(backoffDelayMs(n, () => 0)).toBe(1_000);
  });

  it("tiene jitter: con distintos sorteos da distintos retrasos dentro de la ventana", () => {
    const delays = new Set([0.1, 0.4, 0.7, 0.95].map((r) => backoffDelayMs(4, () => r)));
    expect(delays.size).toBe(4);
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(1_000);
      expect(d).toBeLessThanOrEqual(32_000);
    }
  });

  it("con Math.random real queda siempre en [1 s, 60 s]", () => {
    for (let i = 0; i < 500; i++) {
      const d = backoffDelayMs(i % 20);
      expect(d).toBeGreaterThanOrEqual(1_000);
      expect(d).toBeLessThanOrEqual(60_000);
    }
  });
});

describe("Retry-After", () => {
  it("segundos enteros", () => expect(parseRetryAfter("30", 0)).toBe(30_000));
  it("fecha HTTP", () => {
    const now = Date.parse("2026-10-05T12:00:00Z");
    expect(parseRetryAfter("Mon, 05 Oct 2026 12:01:00 GMT", now)).toBe(60_000);
  });
  it("ausente o ilegible da null", () => {
    expect(parseRetryAfter(null, 0)).toBeNull();
    expect(parseRetryAfter("", 0)).toBeNull();
    expect(parseRetryAfter("pronto", 0)).toBeNull();
  });
  it("nunca espera menos que Retry-After, y recorta un valor absurdo", () => {
    expect(delayWithRetryAfter(2_000, 30_000)).toBe(30_000);
    expect(delayWithRetryAfter(45_000, 30_000)).toBe(45_000);
    expect(delayWithRetryAfter(2_000, null)).toBe(2_000);
    expect(delayWithRetryAfter(2_000, 10 * 3_600_000)).toBe(15 * 60_000);
  });
});

describe("backoff en el motor (fake timers)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it("fallos consecutivos alargan la espera y el éxito la reinicia", async () => {
    const ctx = setup();
    await ctx.outbox.enqueue(makePoint(1));
    const waits: number[] = [];
    for (let i = 0; i < 4; i++) {
      ctx.transport.push(http(500));
      const before = Date.now();
      ctx.clock.now = before;
      const result = await ctx.engine.drain({ force: true });
      waits.push(result.nextAttemptAt! - before);
      vi.advanceTimersByTime(result.nextAttemptAt! - before + 1);
      ctx.clock.now = Date.now();
    }
    // random fijo en 0.5: ventana [1 s, techo], punto medio.
    expect(waits).toEqual([1_500, 2_500, 4_500, 8_500]);
    expect(await ctx.store.getMeta("backoffAttempt")).toBe("4");

    ctx.transport.push((b) => http(202, { schemaVersion: 1, accepted: b.points.map((p) => (p as { eventId: string }).eventId), rejected: [], serverTime: new Date().toISOString() }));
    await ctx.engine.drain({ force: true });
    expect(await ctx.store.getMeta("backoffAttempt")).toBe("0");
  });

  it("el mismo reloj fake: el motor no reintenta antes de nextAttemptAt y sí después", async () => {
    const ctx = setup();
    await ctx.outbox.enqueue(makePoint(1));
    ctx.clock.now = Date.now();
    ctx.transport.push(http(503, undefined, "10"));
    const first = await ctx.engine.drain();
    expect(first.nextAttemptAt! - ctx.clock.now).toBeGreaterThanOrEqual(10_000);

    vi.advanceTimersByTime(5_000);
    ctx.clock.now = Date.now();
    expect((await ctx.engine.drain()).outcome).toBe("backoff");
    expect(ctx.transport.sentBatches).toHaveLength(1);

    vi.advanceTimersByTime(60_000);
    ctx.clock.now = Date.now();
    ctx.transport.push((b) => http(202, { schemaVersion: 1, accepted: b.points.map((p) => (p as { eventId: string }).eventId), rejected: [], serverTime: new Date().toISOString() }));
    expect((await ctx.engine.drain()).outcome).toBe("drained");
  });
});
