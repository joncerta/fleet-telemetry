import { TOPICS, telemetryDlqMessageSchema, type TelemetryDlqMessage } from "@fleet/contracts";
import { CORRELATION_ID_HEADER, type FleetProducer, type FleetSendBatch } from "@fleet/platform";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeadLetterEntry } from "../application/ports.js";
import { createKafkaDeadLetterPublisher, PublishTimeoutError } from "./kafka-dead-letter-publisher.js";

const VEHICLE = "a1c4e9d2-7b3f-4c58-8e16-0d9f2b6a4c71";

const message = (code: TelemetryDlqMessage["reason"]["code"]): TelemetryDlqMessage => ({
  schemaVersion: 1,
  source: "processor",
  reason: { code, message: "motivo" },
  failedAt: "2026-03-14T20:00:00.000Z",
  tenantId: "9d7e1b34-2a6c-4f08-b5d3-6e4a8c1f0b92",
  deviceId: "5b8a3f6c-1e9d-4a27-8c40-7f2e6d1b9a35",
  vehicleId: VEHICLE,
  eventId: "3f2b8c1e-5d4a-4e7b-9a61-2c8d0e5f7a10",
  attempts: 0,
  originalPayload: { cualquier: "cosa" },
});

const entry = (correlationId = "corr-1", key = VEHICLE): DeadLetterEntry => ({ key, correlationId, message: message("outside_operating_area") });

function fakeProducer(behavior: () => Promise<unknown> = () => Promise.resolve([])) {
  const batches: FleetSendBatch[] = [];
  const producer: Pick<FleetProducer, "sendBatch"> = {
    sendBatch: (batch) => {
      batches.push(batch);
      return behavior().then(() => []);
    },
  };
  return { producer, batches };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createKafkaDeadLetterPublisher", () => {
  it("un solo sendBatch a telemetry.dlq con la key y el correlationId de cada entrada y el mensaje como JSON", async () => {
    const { producer, batches } = fakeProducer();
    const publisher = createKafkaDeadLetterPublisher({ producer, timeoutMs: 5_000 });
    const entries = [entry("corr-a"), entry("corr-b", "otra-key")];

    await publisher.publish(entries);

    expect(batches).toHaveLength(1);
    expect(batches[0]?.topicMessages).toHaveLength(1);
    expect(batches[0]?.topicMessages[0]?.topic).toBe(TOPICS.telemetryDlq);
    const messages = batches[0]?.topicMessages[0]?.messages ?? [];
    expect(messages.map((m) => m.key)).toEqual([VEHICLE, "otra-key"]);
    expect(messages.map((m) => m.headers[CORRELATION_ID_HEADER])).toEqual(["corr-a", "corr-b"]);
    expect(messages.map((m) => telemetryDlqMessageSchema.parse(JSON.parse(String(m.value))))).toEqual(entries.map((e) => e.message));
  });

  it("parte la publicación en sub-lotes por tamaño, en orden y sin perder ninguna entrada (el broker rechaza un batch de más de 1 MiB)", async () => {
    const { producer, batches } = fakeProducer();
    const big = (n: number): DeadLetterEntry => ({
      key: VEHICLE,
      correlationId: `corr-${n}`,
      message: { ...message("outside_operating_area"), originalPayload: "z".repeat(2_000) },
    });
    const entries = Array.from({ length: 10 }, (_, i) => big(i));

    // Con ~2 KB por mensaje y un tope de 5 KB caben 2 por sub-lote.
    await createKafkaDeadLetterPublisher({ producer, timeoutMs: 5_000, maxBatchBytes: 5_000 }).publish(entries);

    expect(batches.length).toBeGreaterThan(1);
    const sent = batches.flatMap((batch) => batch.topicMessages.flatMap((topicMessages) => topicMessages.messages));
    expect(sent.map((m) => m.headers[CORRELATION_ID_HEADER])).toEqual(entries.map((e) => e.correlationId));
    for (const batch of batches) {
      expect(batch.topicMessages).toHaveLength(1);
      expect(batch.timeout).toBe(5_000);
      const bytes = (batch.topicMessages[0]?.messages ?? []).reduce((total, m) => total + Buffer.byteLength(String(m.value)), 0);
      expect(bytes).toBeLessThanOrEqual(5_000);
    }
  });

  it("si un sub-lote falla, no se envían los siguientes y el error sube (el tramo no se confirma)", async () => {
    let calls = 0;
    const { producer, batches } = fakeProducer(() => {
      calls += 1;
      return calls === 2 ? Promise.reject(new Error("MESSAGE_TOO_LARGE")) : Promise.resolve([]);
    });
    const entries = Array.from({ length: 10 }, (_, i) => ({ ...entry(`corr-${i}`), message: { ...message("outside_operating_area"), originalPayload: "z".repeat(2_000) } }));

    await expect(createKafkaDeadLetterPublisher({ producer, timeoutMs: 5_000, maxBatchBytes: 5_000 }).publish(entries)).rejects.toThrow("MESSAGE_TOO_LARGE");
    expect(batches).toHaveLength(2);
  });

  it("sin entradas no envía nada", async () => {
    const { producer, batches } = fakeProducer();

    await createKafkaDeadLetterPublisher({ producer, timeoutMs: 5_000 }).publish([]);

    expect(batches).toEqual([]);
  });

  it("pasa el timeout al broker y usa un tópico configurable", async () => {
    const { producer, batches } = fakeProducer();

    await createKafkaDeadLetterPublisher({ producer, timeoutMs: 1_234, topic: "t.dlq" }).publish([entry()]);

    expect([batches[0]?.topicMessages[0]?.topic, batches[0]?.timeout]).toEqual(["t.dlq", 1_234]);
  });

  it("propaga el error del productor", async () => {
    const { producer } = fakeProducer(() => Promise.reject(new Error("broker no disponible")));

    await expect(createKafkaDeadLetterPublisher({ producer, timeoutMs: 5_000 }).publish([entry()])).rejects.toThrow("broker no disponible");
  });

  it("rechaza con PublishTimeoutError si el broker no confirma a tiempo, y no deja el temporizador activo", async () => {
    vi.useFakeTimers();
    const { producer } = fakeProducer(() => new Promise<never>(() => undefined));
    const publisher = createKafkaDeadLetterPublisher({ producer, timeoutMs: 8_000 });

    const outcome = publisher.publish([entry()]).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(7_999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(await outcome).toBeInstanceOf(PublishTimeoutError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancela el temporizador cuando la publicación termina bien", async () => {
    vi.useFakeTimers();
    const { producer } = fakeProducer();

    await createKafkaDeadLetterPublisher({ producer, timeoutMs: 8_000 }).publish([entry()]);

    expect(vi.getTimerCount()).toBe(0);
  });

  it("un correlationId inválido se rechaza antes de enviar nada", async () => {
    const { producer, batches } = fakeProducer();

    await expect(createKafkaDeadLetterPublisher({ producer, timeoutMs: 5_000 }).publish([entry("con espacios\n")])).rejects.toThrow(/correlationId/);
    expect(batches).toEqual([]);
  });
});
