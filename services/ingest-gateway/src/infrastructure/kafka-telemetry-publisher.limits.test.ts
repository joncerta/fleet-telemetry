import { TOPICS, telemetryDlqMessageSchema, type TelemetryDlqMessage, type TelemetryRawEvent } from "@fleet/contracts";
import type { FleetProducer, FleetSendBatch } from "@fleet/platform";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicationFailedError } from "../application/errors.js";
import { createKafkaTelemetryPublisher, PublishTimeoutError } from "./kafka-telemetry-publisher.js";

// Límites del publicador: sub-lotes acotados por tamaño (M4) y publicaciones en vuelo acotadas (M5).

const VEHICLE = "a1c4e9d2-7b3f-4c58-8e16-0d9f2b6a4c71";
const context = { vehicleId: VEHICLE, correlationId: "corr-limits" };
const EVENT_ID = "3f2b8c1e-5d4a-4e7b-9a61-2c8d0e5f7a10";

const event = (): TelemetryRawEvent => ({
  schemaVersion: 1,
  tenantId: "9d7e1b34-2a6c-4f08-b5d3-6e4a8c1f0b92",
  deviceId: "5b8a3f6c-1e9d-4a27-8c40-7f2e6d1b9a35",
  receivedAt: "2026-03-14T20:00:00.000Z",
  point: {
    eventId: EVENT_ID,
    vehicleId: VEHICLE,
    recordedAt: "2026-03-14T19:59:30.000Z",
    lon: -75.5636,
    lat: 6.2518,
    speedMps: null,
    headingDeg: null,
    accuracyM: null,
    mocked: false,
    lowAccuracy: false,
  },
});

const dlqMessage = (n: number, bytes: number): TelemetryDlqMessage => ({
  schemaVersion: 1,
  source: "ingest-gateway",
  reason: { code: "invalid_schema", message: "Campos inválidos: lat." },
  failedAt: "2026-03-14T20:00:00.000Z",
  tenantId: "9d7e1b34-2a6c-4f08-b5d3-6e4a8c1f0b92",
  deviceId: "5b8a3f6c-1e9d-4a27-8c40-7f2e6d1b9a35",
  vehicleId: VEHICLE,
  eventId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  attempts: 0,
  originalPayload: "z".repeat(bytes),
});

const sizeOf = (messages: readonly { value?: unknown }[]) => messages.reduce((total, message) => total + Buffer.byteLength(String(message.value)), 0);

/** Productor cuyos envíos se resuelven a mano: `pending[i]()` confirma el envío i. */
function manualProducer() {
  const pending: (() => void)[] = [];
  const batches: FleetSendBatch[] = [];
  const producer: Pick<FleetProducer, "sendBatch"> = {
    sendBatch: (batch) => {
      batches.push(batch);
      return new Promise((resolve) => {
        pending.push(() => resolve([]));
      });
    },
  };
  return { producer, pending, batches };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("sub-lotes acotados por tamaño", () => {
  function recordingProducer() {
    const batches: FleetSendBatch[] = [];
    const producer: Pick<FleetProducer, "sendBatch"> = {
      sendBatch: (batch) => {
        batches.push(batch);
        return Promise.resolve([]);
      },
    };
    return { producer, batches };
  }

  it("reparte la DLQ en varios sendBatch de a lo sumo maxBatchBytes, en orden y sin perder ni repetir mensajes", async () => {
    const { producer, batches } = recordingProducer();
    const publisher = createKafkaTelemetryPublisher({ producer, timeoutMs: 5_000, maxInFlight: 100, maxBatchBytes: 50_000 });
    const messages = Array.from({ length: 10 }, (_, n) => dlqMessage(n, 20_000));

    await publisher.publishRejected(context, messages);

    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      expect(batch.topicMessages).toHaveLength(1);
      expect(batch.topicMessages[0]?.topic).toBe(TOPICS.telemetryDlq);
      expect(sizeOf(batch.topicMessages[0]?.messages ?? [])).toBeLessThanOrEqual(50_000);
    }
    const sent = batches.flatMap((batch) => batch.topicMessages.flatMap((entry) => entry.messages));
    expect(sent.map((message) => telemetryDlqMessageSchema.parse(JSON.parse(String(message.value))).eventId)).toEqual(messages.map((message) => message.eventId));
  });

  it("un lote que cabe entero sigue siendo un solo sendBatch", async () => {
    const { producer, batches } = recordingProducer();
    const publisher = createKafkaTelemetryPublisher({ producer, timeoutMs: 5_000, maxInFlight: 100, maxBatchBytes: 512 * 1024 });

    await publisher.publishRejected(context, [dlqMessage(1, 100), dlqMessage(2, 100), dlqMessage(3, 100)]);

    expect(batches).toHaveLength(1);
  });

  it("por defecto el tope de un sendBatch es de unos 512 KB", async () => {
    const { producer, batches } = recordingProducer();
    const publisher = createKafkaTelemetryPublisher({ producer, timeoutMs: 5_000, maxInFlight: 100 });

    await publisher.publishRejected(
      context,
      Array.from({ length: 500 }, (_, n) => dlqMessage(n, 2_000)),
    );

    expect(batches.length).toBeGreaterThanOrEqual(2);
    for (const batch of batches) expect(sizeOf(batch.topicMessages[0]?.messages ?? [])).toBeLessThanOrEqual(512 * 1024);
  });

  it("un mensaje más grande que el límite viaja solo en su propio sendBatch (no se puede partir)", async () => {
    const { producer, batches } = recordingProducer();
    const publisher = createKafkaTelemetryPublisher({ producer, timeoutMs: 5_000, maxInFlight: 100, maxBatchBytes: 10_000 });

    await publisher.publishRejected(context, [dlqMessage(1, 100), dlqMessage(2, 30_000), dlqMessage(3, 100)]);

    expect(batches.map((batch) => batch.topicMessages[0]?.messages.length)).toEqual([1, 1, 1]);
  });

  it("los sub-lotes se envían de a uno: el siguiente no sale hasta que el anterior se confirma", async () => {
    const { producer, pending, batches } = manualProducer();
    const publisher = createKafkaTelemetryPublisher({ producer, timeoutMs: 5_000, maxInFlight: 100, maxBatchBytes: 10_000 });

    const done = publisher.publishRejected(context, [dlqMessage(1, 8_000), dlqMessage(2, 8_000)]);
    await Promise.resolve();
    await Promise.resolve();
    expect(batches).toHaveLength(1);
    pending[0]?.();
    await vi.waitFor(() => expect(batches).toHaveLength(2));
    pending[1]?.();

    await expect(done).resolves.toBeUndefined();
  });

  it("tras vencer el tiempo no se envían los sub-lotes que faltaban (no deja trabajo huérfano)", async () => {
    vi.useFakeTimers();
    const { producer, pending, batches } = manualProducer();
    const publisher = createKafkaTelemetryPublisher({ producer, timeoutMs: 1_000, maxInFlight: 100, maxBatchBytes: 10_000 });

    const outcome = publisher.publishRejected(context, [dlqMessage(1, 8_000), dlqMessage(2, 8_000)]).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await outcome).toBeInstanceOf(PublishTimeoutError);
    pending[0]?.();
    await vi.advanceTimersByTimeAsync(10);

    expect(batches).toHaveLength(1);
  });
});

describe("publicaciones en vuelo acotadas (un timeout no cancela el envío de kafkajs: sigue en vuelo)", () => {
  it("por encima de maxInFlight lanza PublicationFailedError SIN llamar a kafkajs, aunque los envíos anteriores ya hayan vencido su timeout", async () => {
    vi.useFakeTimers();
    const { producer, batches } = manualProducer();
    const publisher = createKafkaTelemetryPublisher({ producer, timeoutMs: 1_000, maxInFlight: 2 });
    const publish = () => publisher.publishAccepted(context, [event()]).catch((error: unknown) => error);

    const first = publish();
    const second = publish();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await first).toBeInstanceOf(PublishTimeoutError);
    expect(await second).toBeInstanceOf(PublishTimeoutError);
    expect(batches).toHaveLength(2);

    const third = await publish();

    expect(third).toBeInstanceOf(PublicationFailedError);
    expect(third).toMatchObject({ targets: ["telemetry.raw"] });
    expect(batches).toHaveLength(2);
  });

  it("el destino del error es el tópico al que iba la publicación", async () => {
    vi.useFakeTimers();
    const { producer } = manualProducer();
    const publisher = createKafkaTelemetryPublisher({ producer, timeoutMs: 1_000, maxInFlight: 1 });
    const first = publisher.publishAccepted(context, [event()]).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    await first;

    await expect(publisher.publishRejected(context, [dlqMessage(1, 10)])).rejects.toMatchObject({ name: "PublicationFailedError", targets: ["telemetry.dlq"] });
  });

  it("cuando un envío vencido termina, el contador baja y se vuelve a publicar", async () => {
    vi.useFakeTimers();
    const { producer, pending, batches } = manualProducer();
    const publisher = createKafkaTelemetryPublisher({ producer, timeoutMs: 1_000, maxInFlight: 1 });
    const first = publisher.publishAccepted(context, [event()]).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    await first;
    await expect(publisher.publishAccepted(context, [event()])).rejects.toBeInstanceOf(PublicationFailedError);

    pending[0]?.();
    await vi.advanceTimersByTimeAsync(0);
    const again = publisher.publishAccepted(context, [event()]);
    await vi.advanceTimersByTimeAsync(0);
    pending[1]?.();

    await expect(again).resolves.toBeUndefined();
    expect(batches).toHaveLength(2);
  });

  it("los envíos que terminan (bien o mal) liberan su lugar: muchas publicaciones seguidas no agotan el límite", async () => {
    const outcomes: (() => ReturnType<FleetProducer["sendBatch"]>)[] = [];
    const producer: Pick<FleetProducer, "sendBatch"> = { sendBatch: () => (outcomes.shift() ?? (() => Promise.resolve([])))() };
    const publisher = createKafkaTelemetryPublisher({ producer, timeoutMs: 5_000, maxInFlight: 1 });

    for (let i = 0; i < 5; i += 1) await publisher.publishAccepted(context, [event()]);
    outcomes.push(() => Promise.reject(new Error("broker caído")));
    await expect(publisher.publishAccepted(context, [event()])).rejects.toThrow("broker caído");

    await expect(publisher.publishAccepted(context, [event()])).resolves.toBeUndefined();
  });
});
