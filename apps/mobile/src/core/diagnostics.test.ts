import { describe, expect, it } from "vitest";
import { connectionStateOf, readDiagnostics, syncSummaryOf } from "./diagnostics";
import { ack, http, makePoint, setup } from "./test-helpers";

describe("readDiagnostics", () => {
  it("refleja conteos, rechazados por motivo, último ACK y último error", async () => {
    const ctx = setup();
    await ctx.outbox.enqueue(makePoint(1));
    await ctx.outbox.enqueue(makePoint(2));
    ctx.transport.push(http(202, ack([makePoint(1).eventId], [{ eventId: makePoint(2).eventId, reason: "stale_timestamp" }])));
    await ctx.engine.drain();

    const d = await readDiagnostics(ctx.store);

    expect(d.counts).toMatchObject({ pending: 0, sent: 1, rejected: 1 });
    expect(d.rejectedByReason).toEqual({ stale_timestamp: 1 });
    expect(d.lastServerTime).toBe("2026-10-05T12:00:00.000Z");
    expect(d.lastAckAccepted).toBe(1);
    expect(d.lastAckRejected).toBe(1);
    expect(d.lastError).toBeNull();
  });

  it("muestra el último error y la pausa por 401", async () => {
    const ctx = setup();
    await ctx.outbox.enqueue(makePoint(1));
    ctx.transport.push(http(401));
    await ctx.engine.drain();
    const d = await readDiagnostics(ctx.store);
    expect(d.lastError).toBe("http_401");
    expect(d.pausedReason).toBe("unauthorized");
    expect(syncSummaryOf(d, ctx.clock.now)).toBe("paused");
  });
});

describe("connectionStateOf", () => {
  it("isConnected no es internet: usa isInternetReachable", () => {
    expect(connectionStateOf({ isConnected: true, isInternetReachable: false })).toBe("offline");
    expect(connectionStateOf({ isConnected: true, isInternetReachable: true })).toBe("online");
    expect(connectionStateOf({ isConnected: true, isInternetReachable: null })).toBe("unknown");
    expect(connectionStateOf({ isConnected: false, isInternetReachable: null })).toBe("offline");
    expect(connectionStateOf({ isConnected: null, isInternetReachable: null })).toBe("unknown");
  });
});

describe("syncSummaryOf", () => {
  const counts = { pending: 0, inFlight: 0, rejected: 0, dead: 0, sent: 0, discarded: 0, invalidLocal: 0 };
  it("idle, synced, pending, backoff", () => {
    expect(syncSummaryOf({ counts, pausedReason: null, nextAttemptAt: null }, 0)).toBe("idle");
    expect(syncSummaryOf({ counts: { ...counts, sent: 5 }, pausedReason: null, nextAttemptAt: null }, 0)).toBe("synced");
    expect(syncSummaryOf({ counts: { ...counts, pending: 2 }, pausedReason: null, nextAttemptAt: null }, 0)).toBe("pending");
    expect(syncSummaryOf({ counts: { ...counts, pending: 2 }, pausedReason: null, nextAttemptAt: 10 }, 5)).toBe("backoff");
    expect(syncSummaryOf({ counts: { ...counts, pending: 2 }, pausedReason: null, nextAttemptAt: 10 }, 11)).toBe("pending");
  });
});
