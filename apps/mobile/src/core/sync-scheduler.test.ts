import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncScheduler } from "./sync-scheduler";
import type { DrainResult } from "./sync-engine";

const done: DrainResult = { outcome: "drained", sent: 1, rejected: 0, batches: 1, nextAttemptAt: null };

function make(pending: number, random = 0.5) {
  const drain = vi.fn<(o: { force?: boolean }) => Promise<DrainResult>>(() => Promise.resolve(done));
  const scheduler = new SyncScheduler({
    drain,
    pendingCount: () => Promise.resolve(pending),
    periodicMs: 15_000,
    regainJitterMaxMs: 2_000,
    random: () => random,
  });
  return { drain, scheduler };
}

describe("SyncScheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("cada 15 s intenta mientras haya pendientes", async () => {
    const { drain, scheduler } = make(3);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(drain).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(drain).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(drain).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it("sin pendientes no intenta nada", async () => {
    const { drain, scheduler } = make(0);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(drain).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it("sin internet (isInternetReachable=false) no intenta; con null sí (manda el request)", async () => {
    const { drain, scheduler } = make(3);
    scheduler.start();
    scheduler.setReachable(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(drain).not.toHaveBeenCalled();
    scheduler.setReachable(null);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(drain).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("al recuperar la red espera un jitter y luego fuerza el envío", async () => {
    const { drain, scheduler } = make(3, 0.5);
    scheduler.setReachable(false);
    scheduler.setReachable(true);
    await vi.advanceTimersByTimeAsync(999);
    expect(drain).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(drain).toHaveBeenCalledWith({ force: true });
  });

  it("jitter distinto para dispositivos distintos", async () => {
    const a = make(1, 0.1);
    const b = make(1, 0.9);
    for (const s of [a.scheduler, b.scheduler]) {
      s.setReachable(false);
      s.setReachable(true);
    }
    await vi.advanceTimersByTimeAsync(300);
    expect(a.drain).toHaveBeenCalledTimes(1);
    expect(b.drain).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_600);
    expect(b.drain).toHaveBeenCalledTimes(1);
  });

  it("perder la red durante el jitter cancela el intento", async () => {
    const { drain, scheduler } = make(3);
    scheduler.setReachable(true);
    scheduler.setReachable(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(drain).not.toHaveBeenCalled();
  });

  it("more_pending vuelve a intentar tras una pausa corta, no en bucle apretado", async () => {
    const { drain, scheduler } = make(3);
    drain.mockResolvedValueOnce({ ...done, outcome: "more_pending" });
    scheduler.onForeground();
    await vi.advanceTimersByTimeAsync(0);
    expect(drain).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(249);
    expect(drain).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(drain).toHaveBeenCalledTimes(2);
  });
});
