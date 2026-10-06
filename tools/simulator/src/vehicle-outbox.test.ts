import type { TelemetryPoint } from "@fleet/contracts";
import { describe, expect, it, vi } from "vitest";
import type { SendBatchInput, SendOutcome, Sender } from "./sender.js";
import { createStatsCollector } from "./stats.js";
import { createVehicleOutbox } from "./vehicle-outbox.js";

const TENANT = "f1ee7000-0000-4000-8000-000000000001";
const NOW = new Date("2026-10-06T15:00:00.000Z");

const pointOf = (n: number): TelemetryPoint => ({
  eventId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  vehicleId: "f1ee7000-0000-4000-9000-000000001001",
  recordedAt: new Date(NOW.getTime() + n * 1_000).toISOString(),
  lon: -74.08,
  lat: 4.65,
  speedMps: 5,
  headingDeg: 90,
  accuracyM: 8,
  mocked: false,
  lowAccuracy: false,
});

function setup(outcomes: SendOutcome[]) {
  const sent: SendBatchInput[] = [];
  const sender: Sender = {
    send: vi.fn((batch: SendBatchInput) => {
      sent.push(batch);
      const outcome = outcomes.shift();
      if (outcome === undefined) throw new Error("sin resultado preparado");
      return Promise.resolve(outcome);
    }),
  };
  const stats = createStatsCollector();
  const outbox = createVehicleOutbox({ tenantId: TENANT, token: "fdt_x", sender, stats, now: () => NOW, newCorrelationId: () => "corr" });
  return { sent, stats, outbox };
}

const ack = (accepted: number, rejected = 0): SendOutcome => ({
  kind: "acked",
  latencyMs: 30,
  ack: {
    schemaVersion: 1,
    accepted: Array.from({ length: accepted }, (_, n) => pointOf(n + 1).eventId),
    rejected: Array.from({ length: rejected }, (_, index) => ({ index, eventId: null, reason: "invalid_schema" as const })),
    serverTime: NOW.toISOString(),
  },
});

describe("createVehicleOutbox", () => {
  it("con ACK vacía la cola y cuenta enviados, aceptados, rechazados y latencia por tenant", async () => {
    const { outbox, stats, sent } = setup([ack(2, 1)]);
    outbox.enqueue([pointOf(1), pointOf(2), pointOf(3)]);

    await outbox.flush();

    expect(outbox.pending()).toBe(0);
    expect(sent[0]?.points).toHaveLength(3);
    expect(stats.summaries()).toEqual([
      expect.objectContaining({ tenantId: TENANT, sent: 3, accepted: 2, rejected: 1, failedBatches: 0, ackLatencyAvgMs: 30, ackLatencyMaxMs: 30 }),
    ]);
  });

  it("ante un fallo transitorio conserva los puntos y los reenvía con los mismos eventId", async () => {
    const { outbox, stats, sent } = setup([{ kind: "retry", status: 503, latencyMs: 10 }, ack(2)]);
    outbox.enqueue([pointOf(1), pointOf(2)]);

    await outbox.flush();
    expect(outbox.pending()).toBe(2);
    await outbox.flush();

    expect(outbox.pending()).toBe(0);
    expect(sent[1]?.points.map((point) => point.eventId)).toEqual(sent[0]?.points.map((point) => point.eventId));
    expect(stats.summaries()[0]).toMatchObject({ failedBatches: 1, accepted: 2, dropped: 0 });
  });

  it("descarta el lote ante un 4xx permanente", async () => {
    const { outbox, stats } = setup([{ kind: "permanent", status: 401, latencyMs: 5 }]);
    outbox.enqueue([pointOf(1)]);

    await outbox.flush();

    expect(outbox.pending()).toBe(0);
    expect(stats.summaries()[0]).toMatchObject({ failedBatches: 1, dropped: 1 });
  });

  it("acota la cola a un lote y descarta los más viejos", async () => {
    const { outbox, stats, sent } = setup([ack(500)]);
    outbox.enqueue(Array.from({ length: 510 }, (_, n) => pointOf(n + 1)));

    expect(outbox.pending()).toBe(500);
    await outbox.flush();

    expect(sent[0]?.points[0]?.eventId).toBe(pointOf(11).eventId);
    expect(stats.summaries()[0]).toMatchObject({ dropped: 10 });
  });

  it("no envía nada si no hay puntos", async () => {
    const { outbox, sent } = setup([]);

    await outbox.flush();

    expect(sent).toHaveLength(0);
  });
});
