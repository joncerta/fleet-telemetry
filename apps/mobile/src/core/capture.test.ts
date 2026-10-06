import { describe, expect, it } from "vitest";
import { captureFixes } from "./capture";
import type { RawFix } from "./point";
import { VEHICLE_ID, setup, uuid } from "./test-helpers";

const fix = (n: number, over: Partial<RawFix> = {}): RawFix => ({
  timestamp: 1_700_000_000_000 + n * 5_000,
  latitude: 4.6,
  longitude: -74.08,
  altitude: null,
  accuracy: 10,
  speed: 5,
  heading: 10,
  mocked: false,
  ...over,
});

describe("captureFixes", () => {
  it("escribe cada punto validado en la cola y no envía nada", async () => {
    const ctx = setup();
    let n = 0;
    const result = await captureFixes([fix(1), fix(2), fix(3)], { outbox: ctx.outbox, vehicleId: VEHICLE_ID, newEventId: () => uuid(++n) });
    expect(result).toEqual({ enqueued: 3, invalid: 0, lastFixAt: fix(3).timestamp });
    expect((await ctx.store.counts()).pending).toBe(3);
    expect(ctx.transport.sentBatches).toHaveLength(0);
  });

  it("los puntos de baja precisión y simulados se encolan marcados", async () => {
    const ctx = setup();
    let n = 0;
    await captureFixes([fix(1, { accuracy: 120 }), fix(2, { mocked: true })], { outbox: ctx.outbox, vehicleId: VEHICLE_ID, newEventId: () => uuid(++n) });
    const payloads = [...ctx.store.rows.values()].map((r) => JSON.parse(r.payload) as { lowAccuracy: boolean; mocked: boolean });
    expect(payloads[0]?.lowAccuracy).toBe(true);
    expect(payloads[1]?.mocked).toBe(true);
  });

  it("un fix inválido se cuenta y no se encola", async () => {
    const ctx = setup();
    let n = 0;
    const result = await captureFixes([fix(1, { latitude: 200 }), fix(2)], { outbox: ctx.outbox, vehicleId: VEHICLE_ID, newEventId: () => uuid(++n) });
    expect(result.enqueued).toBe(1);
    expect(result.invalid).toBe(1);
    expect((await ctx.store.counts()).invalidLocal).toBe(1);
  });

  it("sin vehículo vinculado nada se encola, pero queda contado", async () => {
    const ctx = setup();
    const result = await captureFixes([fix(1), fix(2)], { outbox: ctx.outbox, vehicleId: null, newEventId: () => uuid(1) });
    expect(result).toEqual({ enqueued: 0, invalid: 2, lastFixAt: null });
    expect((await ctx.store.counts()).invalidLocal).toBe(2);
  });
});
