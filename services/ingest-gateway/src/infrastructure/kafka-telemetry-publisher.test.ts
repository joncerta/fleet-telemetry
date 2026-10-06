import { TOPICS, telemetryDlqMessageSchema, telemetryRawEventSchema, type TelemetryDlqMessage, type TelemetryRawEvent } from "@fleet/contracts";
import { CORRELATION_ID_HEADER, type FleetProducer, type FleetSendBatch } from "@fleet/platform";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createKafkaTelemetryPublisher, PublishTimeoutError } from "./kafka-telemetry-publisher.js";

const VEHICLE = "a1c4e9d2-7b3f-4c58-8e16-0d9f2b6a4c71";
const context = { vehicleId: VEHICLE, correlationId: "corr-1" };

const event = (eventId: string, vehicleId = VEHICLE): TelemetryRawEvent => ({
  schemaVersion: 1,
  tenantId: "9d7e1b34-2a6c-4f08-b5d3-6e4a8c1f0b92",
  deviceId: "5b8a3f6c-1e9d-4a27-8c40-7f2e6d1b9a35",
  receivedAt: "2026-03-14T20:00:00.000Z",
  point: {
    eventId,
    vehicleId,
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

const dlq: TelemetryDlqMessage = {
  schemaVersion: 1,
  source: "ingest-gateway",
  reason: { code: "invalid_schema", message: "Campos inválidos: lat." },
  failedAt: "2026-03-14T20:00:00.000Z",
  tenantId: "9d7e1b34-2a6c-4f08-b5d3-6e4a8c1f0b92",
  deviceId: "5b8a3f6c-1e9d-4a27-8c40-7f2e6d1b9a35",
  vehicleId: VEHICLE,
  eventId: null,
  attempts: 0,
  originalPayload: { lat: 999 },
};

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

describe("createKafkaTelemetryPublisher", () => {
  it("publishAccepted: un solo sendBatch a telemetry.raw con key = vehicleId del contexto, header correlationId y el evento como JSON", async () => {
    const { producer, batches } = fakeProducer();
    const publisher = createKafkaTelemetryPublisher({ producer, timeoutMs: 5_000, maxInFlight: 100 });
    const events = [event("3f2b8c1e-5d4a-4e7b-9a61-2c8d0e5f7a10"), event("7c1d5e92-4b0a-4d63-9f28-3a6b8e0c4d17")];

    await publisher.publishAccepted(context, events);

    expect(batches).toHaveLength(1);
    const [batch] = batches;
    expect(batch?.topicMessages).toHaveLength(1);
    expect(batch?.topicMessages[0]?.topic).toBe(TOPICS.telemetryRaw);
    const messages = batch?.topicMessages[0]?.messages ?? [];
    expect(messages.map((message) => message.key)).toEqual([VEHICLE, VEHICLE]);
    expect(messages.map((message) => message.headers[CORRELATION_ID_HEADER])).toEqual(["corr-1", "corr-1"]);
    expect(messages.map((message) => telemetryRawEventSchema.parse(JSON.parse(String(message.value))))).toEqual(events);
  });

  it("la key es el vehículo del token aunque el uuid del punto venga con otras mayúsculas", async () => {
    const { producer, batches } = fakeProducer();
    const publisher = createKafkaTelemetryPublisher({ producer, timeoutMs: 5_000, maxInFlight: 100 });

    await publisher.publishAccepted(context, [event("3f2b8c1e-5d4a-4e7b-9a61-2c8d0e5f7a10", VEHICLE.toUpperCase())]);

    expect(batches[0]?.topicMessages[0]?.messages[0]?.key).toBe(VEHICLE);
  });

  it("publishRejected: un sendBatch a telemetry.dlq con key = vehicleId, correlationId y el mensaje de la DLQ", async () => {
    const { producer, batches } = fakeProducer();
    const publisher = createKafkaTelemetryPublisher({ producer, timeoutMs: 5_000, maxInFlight: 100 });

    await publisher.publishRejected(context, [dlq]);

    expect(batches).toHaveLength(1);
    expect(batches[0]?.topicMessages[0]?.topic).toBe(TOPICS.telemetryDlq);
    const [message] = batches[0]?.topicMessages[0]?.messages ?? [];
    expect(message?.key).toBe(VEHICLE);
    expect(message?.headers[CORRELATION_ID_HEADER]).toBe("corr-1");
    expect(telemetryDlqMessageSchema.parse(JSON.parse(String(message?.value)))).toEqual(dlq);
  });

  it("pasa el timeout al broker y usa tópicos configurables", async () => {
    const { producer, batches } = fakeProducer();
    const publisher = createKafkaTelemetryPublisher({ producer, timeoutMs: 1_234, maxInFlight: 100, topics: { raw: "t.raw", dlq: "t.dlq" } });

    await publisher.publishAccepted(context, [event("3f2b8c1e-5d4a-4e7b-9a61-2c8d0e5f7a10")]);
    await publisher.publishRejected(context, [dlq]);

    expect(batches.map((batch) => [batch.topicMessages[0]?.topic, batch.timeout])).toEqual([
      ["t.raw", 1_234],
      ["t.dlq", 1_234],
    ]);
  });

  it("propaga el error del productor", async () => {
    const { producer } = fakeProducer(() => Promise.reject(new Error("broker no disponible")));
    const publisher = createKafkaTelemetryPublisher({ producer, timeoutMs: 5_000, maxInFlight: 100 });

    await expect(publisher.publishAccepted(context, [event("3f2b8c1e-5d4a-4e7b-9a61-2c8d0e5f7a10")])).rejects.toThrow("broker no disponible");
  });

  it("rechaza con PublishTimeoutError si el broker no confirma a tiempo, y no deja el temporizador activo", async () => {
    vi.useFakeTimers();
    const { producer } = fakeProducer(() => new Promise<never>(() => undefined));
    const publisher = createKafkaTelemetryPublisher({ producer, timeoutMs: 8_000, maxInFlight: 100 });

    const outcome = publisher.publishAccepted(context, [event("3f2b8c1e-5d4a-4e7b-9a61-2c8d0e5f7a10")]).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(7_999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    const error = await outcome;
    expect(error).toBeInstanceOf(PublishTimeoutError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancela el temporizador cuando la publicación termina bien", async () => {
    vi.useFakeTimers();
    const { producer } = fakeProducer();
    const publisher = createKafkaTelemetryPublisher({ producer, timeoutMs: 8_000, maxInFlight: 100 });

    await publisher.publishAccepted(context, [event("3f2b8c1e-5d4a-4e7b-9a61-2c8d0e5f7a10")]);

    expect(vi.getTimerCount()).toBe(0);
  });

  it("un correlationId inválido se rechaza antes de enviar nada", async () => {
    const { producer, batches } = fakeProducer();
    const publisher = createKafkaTelemetryPublisher({ producer, timeoutMs: 5_000, maxInFlight: 100 });

    await expect(
      publisher.publishAccepted({ vehicleId: VEHICLE, correlationId: "con espacios\n" }, [event("3f2b8c1e-5d4a-4e7b-9a61-2c8d0e5f7a10")]),
    ).rejects.toThrow(/correlationId/);
    expect(batches).toEqual([]);
  });
});
