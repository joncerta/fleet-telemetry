import type { TelemetryPoint } from "@fleet/contracts";
import { describe, expect, it, vi } from "vitest";
import { createRng } from "./rng.js";
import { runVehicle, sleep } from "./runner.js";
import type { VehicleOutbox } from "./vehicle-outbox.js";
import type { VehiclePlan, VehicleSimulator } from "./vehicle-simulator.js";

const START = new Date("2026-10-06T15:00:00.000Z");
const plan: VehiclePlan = { vehicle: { id: "v", tenantId: "t", plate: "P", label: "L" }, behavior: "moving" };

const pointAt = (recordedAt: Date): TelemetryPoint => ({
  eventId: crypto.randomUUID(),
  vehicleId: "f1ee7000-0000-4000-9000-000000001001",
  recordedAt: recordedAt.toISOString(),
  lon: -74.08,
  lat: 4.65,
  speedMps: 5,
  headingDeg: 90,
  accuracyM: 8,
  mocked: false,
  lowAccuracy: false,
});

describe("runVehicle", () => {
  it("envía primero el historial y luego un punto por intervalo con recordedAt del fix, en lotes", async () => {
    let nowMs = START.getTime();
    const controller = new AbortController();
    const queued: TelemetryPoint[][] = [];
    const flushes: number[] = [];
    const simulator: VehicleSimulator = {
      plan,
      history: () => [pointAt(new Date(START.getTime() - 60_000))],
      point: (recordedAt) => pointAt(recordedAt),
    };
    const outbox: VehicleOutbox = {
      enqueue: (points) => void queued.push([...points]),
      pending: () => 0,
      flush: () => {
        flushes.push(nowMs);
        return Promise.resolve();
      },
    };
    let batches = 0;
    // Cada "espera" adelanta el reloj 12 s y a la tercera aborta.
    const fakeSleep = vi.fn((ms: number) => {
      nowMs += 12_000;
      batches += 1;
      if (batches === 3) controller.abort();
      return Promise.resolve(ms).then(() => undefined);
    });

    await runVehicle({
      simulator,
      outbox,
      rng: createRng(1),
      now: () => new Date(nowMs),
      pointIntervalMs: 5_000,
      batchMinMs: 10_000,
      batchMaxMs: 15_000,
      signal: controller.signal,
      sleep: fakeSleep,
    });

    expect(queued[0]).toHaveLength(1);
    // Lote 1 (12 s): puntos en 5 y 10 s; lote 2 (24 s): 15 y 20 s. En el 3.º se abortó antes de generar.
    expect(queued[1]?.map((point) => Date.parse(point.recordedAt) - START.getTime())).toEqual([5_000, 10_000]);
    expect(queued[2]?.map((point) => Date.parse(point.recordedAt) - START.getTime())).toEqual([15_000, 20_000]);
    expect(queued).toHaveLength(3);
    expect(fakeSleep).toHaveBeenCalledTimes(3);
    for (const [min, max] of fakeSleep.mock.calls.map(([ms]) => [ms, ms])) {
      expect(min).toBeGreaterThanOrEqual(10_000);
      expect(max).toBeLessThanOrEqual(15_000);
    }
  });

  it("omite los puntos de un vehículo silencioso (point devuelve null)", async () => {
    let nowMs = START.getTime();
    const controller = new AbortController();
    const queued: TelemetryPoint[][] = [];
    const simulator: VehicleSimulator = { plan, history: () => [], point: () => null };
    const outbox: VehicleOutbox = { enqueue: (points) => void queued.push([...points]), pending: () => 0, flush: () => Promise.resolve() };

    await runVehicle({
      simulator,
      outbox,
      rng: createRng(1),
      now: () => new Date(nowMs),
      pointIntervalMs: 5_000,
      batchMinMs: 10_000,
      batchMaxMs: 15_000,
      signal: controller.signal,
      sleep: () => {
        nowMs += 20_000;
        controller.abort();
        return Promise.resolve();
      },
    });

    expect(queued.at(-1)).toEqual([]);
  });
});

describe("sleep", () => {
  it("termina antes de tiempo al abortar y no deja temporizadores", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const waiting = sleep(60_000, controller.signal);
      controller.abort();
      await expect(waiting).resolves.toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("espera el tiempo pedido", async () => {
    vi.useFakeTimers();
    try {
      let done = false;
      void sleep(1_000, new AbortController().signal).then(() => (done = true));
      await vi.advanceTimersByTimeAsync(999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
