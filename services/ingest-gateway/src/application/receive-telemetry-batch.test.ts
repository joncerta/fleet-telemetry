import {
  batchAckSchema,
  telemetryDlqMessageSchema,
  telemetryRawEventSchema,
  type TelemetryBatchEnvelope,
  type TelemetryDlqMessage,
  type TelemetryRawEvent,
} from "@fleet/contracts";
import { describe, expect, it } from "vitest";
import type { DeviceContext } from "../domain/device.js";
import { PublicationFailedError } from "./errors.js";
import type { Clock, PublishContext, TelemetryPublisher } from "./ports.js";
import { createReceiveTelemetryBatch } from "./receive-telemetry-batch.js";

const DEVICE: DeviceContext = {
  tenantId: "9d7e1b34-2a6c-4f08-b5d3-6e4a8c1f0b92",
  deviceId: "5b8a3f6c-1e9d-4a27-8c40-7f2e6d1b9a35",
  vehicleId: "a1c4e9d2-7b3f-4c58-8e16-0d9f2b6a4c71",
};
const OTHER_VEHICLE = "0e6c2a48-91d5-4f3b-8a07-b5d29c4e1f68";
const E = {
  ok1: "3f2b8c1e-5d4a-4e7b-9a61-2c8d0e5f7a10",
  ok2: "7c1d5e92-4b0a-4d63-9f28-3a6b8e0c4d17",
  bad: "11111111-2222-4333-8444-555555555555",
  other: "22222222-3333-4444-8555-666666666666",
  future: "33333333-4444-4555-8666-777777777777",
  stale: "44444444-5555-4666-8777-888888888888",
  huge: "55555555-6666-4777-8888-999999999999",
};
const NOW = new Date("2026-03-14T20:00:00.000Z");
const CORRELATION_ID = "corr-123";

const clock: Clock = { now: () => NOW };

const point = (eventId: string, overrides: Record<string, unknown> = {}) => ({
  eventId,
  vehicleId: DEVICE.vehicleId,
  recordedAt: "2026-03-14T19:59:30.000Z",
  lon: -75.5636,
  lat: 6.2518,
  speedMps: 12.5,
  headingDeg: 90,
  accuracyM: 8,
  mocked: false,
  lowAccuracy: false,
  ...overrides,
});

const envelope = (points: unknown[]): TelemetryBatchEnvelope => ({ schemaVersion: 1, sentAt: "2026-03-14T19:59:59.000Z", points });

interface Call {
  context: PublishContext;
  events?: readonly TelemetryRawEvent[];
  messages?: readonly TelemetryDlqMessage[];
}

class FakePublisher implements TelemetryPublisher {
  readonly accepted: Call[] = [];
  readonly rejected: Call[] = [];
  failAccepted: Error | undefined;
  failRejected: Error | undefined;

  publishAccepted(context: PublishContext, events: readonly TelemetryRawEvent[]): Promise<void> {
    this.accepted.push({ context, events });
    return this.failAccepted ? Promise.reject(this.failAccepted) : Promise.resolve();
  }

  publishRejected(context: PublishContext, messages: readonly TelemetryDlqMessage[]): Promise<void> {
    this.rejected.push({ context, messages });
    return this.failRejected ? Promise.reject(this.failRejected) : Promise.resolve();
  }
}

const DAY_MS = 86_400_000;
const MAX_POINT_BYTES = 8_192;

function setup(futureToleranceMs = 300_000) {
  const publisher = new FakePublisher();
  const receive = createReceiveTelemetryBatch({ publisher, clock, futureToleranceMs, maxAgeMs: 7 * DAY_MS, maxPointBytes: MAX_POINT_BYTES });
  return { publisher, run: (points: unknown[]) => receive({ device: DEVICE, correlationId: CORRELATION_ID, envelope: envelope(points) }) };
}

describe("receiveTelemetryBatch", () => {
  it("camino feliz: publica los válidos en raw y los devuelve en accepted; no publica nada en la DLQ", async () => {
    const { publisher, run } = setup();

    const ack = await run([point(E.ok1), point(E.ok2)]);

    expect(batchAckSchema.parse(ack)).toEqual({ schemaVersion: 1, accepted: [E.ok1, E.ok2], rejected: [], serverTime: NOW.toISOString() });
    expect(publisher.accepted).toHaveLength(1);
    expect(publisher.accepted[0]?.events?.map((event) => event.point.eventId)).toEqual([E.ok1, E.ok2]);
    expect(publisher.rejected).toEqual([]);
  });

  it("los eventos de raw cumplen telemetryRawEventSchema con tenant y dispositivo del contexto, hora del servidor y el punto tal cual", async () => {
    const { publisher, run } = setup();
    const original = point(E.ok1);

    await run([original]);

    const [event] = publisher.accepted[0]?.events ?? [];
    expect(telemetryRawEventSchema.parse(event)).toEqual({
      schemaVersion: 1,
      tenantId: DEVICE.tenantId,
      deviceId: DEVICE.deviceId,
      receivedAt: NOW.toISOString(),
      point: original,
    });
  });

  it("pasa al publicador el vehículo del token y el correlationId (key y header)", async () => {
    const { publisher, run } = setup();

    await run([point(E.ok1), { eventId: E.bad }]);

    expect(publisher.accepted[0]?.context).toEqual({ vehicleId: DEVICE.vehicleId, correlationId: CORRELATION_ID });
    expect(publisher.rejected[0]?.context).toEqual({ vehicleId: DEVICE.vehicleId, correlationId: CORRELATION_ID });
  });

  it("el tenant y el dispositivo salen del contexto, aunque el punto traiga otros (el esquema los descarta)", async () => {
    const { publisher, run } = setup();

    await run([point(E.ok1, { tenantId: "99999999-9999-4999-8999-999999999999", deviceId: "88888888-8888-4888-8888-888888888888" })]);

    const [event] = publisher.accepted[0]?.events ?? [];
    expect(event).toMatchObject({ tenantId: DEVICE.tenantId, deviceId: DEVICE.deviceId });
  });

  describe("rechazos", () => {
    const batch = () => [
      point(E.ok1),
      { eventId: E.bad, lat: 999 },
      point(E.other, { vehicleId: OTHER_VEHICLE }),
      point(E.future, { recordedAt: "2026-03-14T21:00:00.000Z" }),
      point(E.stale, { recordedAt: "2026-03-06T19:59:59.999Z" }),
    ];

    it("cada rechazo va en rejected del ACK con su índice, eventId y motivo", async () => {
      const { run } = setup();

      const ack = await run(batch());

      expect(batchAckSchema.parse(ack).rejected.map(({ index, eventId, reason }) => ({ index, eventId, reason }))).toEqual([
        { index: 1, eventId: E.bad, reason: "invalid_schema" },
        { index: 2, eventId: E.other, reason: "vehicle_mismatch" },
        { index: 3, eventId: E.future, reason: "future_timestamp" },
        { index: 4, eventId: E.stale, reason: "stale_timestamp" },
      ]);
      expect(ack.accepted).toEqual([E.ok1]);
    });

    it("cada rechazo se publica en la DLQ con el motivo, los ids conocidos, el origen y el punto original", async () => {
      const { publisher, run } = setup();
      const raw = batch();

      await run(raw);

      const messages = publisher.rejected[0]?.messages ?? [];
      expect(messages).toHaveLength(4);
      for (const message of messages) expect(telemetryDlqMessageSchema.parse(message)).toEqual(message);
      expect(messages.map((message) => message.reason.code)).toEqual(["invalid_schema", "vehicle_mismatch", "future_timestamp", "stale_timestamp"]);
      expect(messages[0]).toMatchObject({
        schemaVersion: 1,
        source: "ingest-gateway",
        failedAt: NOW.toISOString(),
        tenantId: DEVICE.tenantId,
        deviceId: DEVICE.deviceId,
        vehicleId: DEVICE.vehicleId,
        eventId: E.bad,
        attempts: 0,
        originalPayload: raw[1],
      });
      expect(messages[1]).toMatchObject({ vehicleId: DEVICE.vehicleId, eventId: E.other, originalPayload: raw[2] });
    });

    it("el mensaje y el detalle del motivo no llevan coordenadas ni el vehículo ajeno", async () => {
      const { publisher, run } = setup();

      const ack = await run(batch());

      const text = JSON.stringify([ack.rejected, (publisher.rejected[0]?.messages ?? []).map((message) => message.reason)]);
      expect(text).not.toMatch(/-75\.5636|6\.2518|999/);
      expect(text).not.toContain(OTHER_VEHICLE);
    });

    it("un lote solo de rechazos no publica nada en raw", async () => {
      const { publisher, run } = setup();

      const ack = await run([{ eventId: E.bad }]);

      expect(ack.accepted).toEqual([]);
      expect(publisher.accepted).toEqual([]);
      expect(publisher.rejected).toHaveLength(1);
    });

    it("un punto que no es un objeto se rechaza con eventId null", async () => {
      const { run } = setup();

      const ack = await run([null]);

      expect(ack.rejected).toEqual([expect.objectContaining({ index: 0, eventId: null, reason: "invalid_schema" })]);
    });

    it("la tolerancia de tiempo futuro es configurable", async () => {
      const { run } = setup(2 * 3_600_000);

      const ack = await run([point(E.future, { recordedAt: "2026-03-14T21:00:00.000Z" })]);

      expect(ack.accepted).toEqual([E.future]);
    });
  });

  it("un punto de hace años NO se publica en raw: es stale_timestamp, va en rejected y en la DLQ", async () => {
    const { publisher, run } = setup();

    const ack = await run([point(E.ok1, { recordedAt: "2020-01-01T00:00:00.000Z" })]);

    expect(ack.accepted).toEqual([]);
    expect(ack.rejected).toEqual([expect.objectContaining({ index: 0, eventId: E.ok1, reason: "stale_timestamp" })]);
    expect(publisher.accepted).toEqual([]);
    expect(publisher.rejected[0]?.messages?.map((message) => message.reason.code)).toEqual(["stale_timestamp"]);
  });

  it("un punto que supera el tamaño máximo va a la DLQ con solo su inicio y su tamaño original, y en rejected como invalid_schema", async () => {
    const { publisher, run } = setup();
    const huge = point(E.huge, { relleno: "x".repeat(MAX_POINT_BYTES * 3) });

    const ack = await run([point(E.ok1), huge]);

    expect(ack.accepted).toEqual([E.ok1]);
    expect(ack.rejected).toEqual([expect.objectContaining({ index: 1, eventId: E.huge, reason: "invalid_schema" })]);
    const [message] = publisher.rejected[0]?.messages ?? [];
    expect(telemetryDlqMessageSchema.parse(message)).toEqual(message);
    expect(message?.truncatedFromBytes).toBe(Buffer.byteLength(JSON.stringify(huge), "utf8"));
    expect(typeof message?.originalPayload).toBe("string");
    expect(JSON.stringify(message).length).toBeLessThan(MAX_POINT_BYTES);
  });

  it("un rechazo normal no lleva truncatedFromBytes", async () => {
    const { publisher, run } = setup();

    await run([{ eventId: E.bad, lat: 999 }]);

    expect(publisher.rejected[0]?.messages?.[0]).not.toHaveProperty("truncatedFromBytes");
  });

  it("un eventId repetido en el lote se publica una vez y aparece una vez en accepted", async () => {
    const { publisher, run } = setup();

    const ack = await run([point(E.ok1), point(E.ok2), point(E.ok1)]);

    expect(ack.accepted).toEqual([E.ok1, E.ok2]);
    expect(publisher.accepted[0]?.events).toHaveLength(2);
    expect(ack.rejected).toEqual([]);
  });

  it("reenviar el mismo lote da el mismo ACK (idempotente)", async () => {
    const { run } = setup();
    const points = [point(E.ok1), point(E.ok2), { eventId: E.bad }];

    const first = await run(points);
    const second = await run(points);

    expect(second).toEqual(first);
  });

  describe("fallo de publicación: se propaga, nunca se traga ni hay ACK parcial", () => {
    it("falla la publicación en raw", async () => {
      const { publisher, run } = setup();
      const cause = new Error("broker caído");
      publisher.failAccepted = cause;

      const failure = await run([point(E.ok1), { eventId: E.bad }]).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(PublicationFailedError);
      expect(failure).toMatchObject({ targets: ["telemetry.raw"], cause });
    });

    it("falla la publicación en la DLQ aunque raw haya funcionado", async () => {
      const { publisher, run } = setup();
      const cause = new Error("timeout de la DLQ");
      publisher.failRejected = cause;

      const failure = await run([point(E.ok1), { eventId: E.bad }]).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(PublicationFailedError);
      expect(failure).toMatchObject({ targets: ["telemetry.dlq"], cause });
      expect(publisher.accepted).toHaveLength(1);
    });

    it("fallan las dos: el error nombra ambos destinos", async () => {
      const { publisher, run } = setup();
      publisher.failAccepted = new Error("raw");
      publisher.failRejected = new Error("dlq");

      const failure = await run([point(E.ok1), { eventId: E.bad }]).catch((error: unknown) => error);

      expect(failure).toMatchObject({ targets: ["telemetry.raw", "telemetry.dlq"] });
    });

    it("un publicador que lanza de forma síncrona también termina en PublicationFailedError", async () => {
      const throwing: TelemetryPublisher = {
        publishAccepted: () => {
          throw new Error("explotó antes de devolver la promesa");
        },
        publishRejected: () => Promise.resolve(),
      };
      const receive = createReceiveTelemetryBatch({ publisher: throwing, clock, futureToleranceMs: 300_000, maxAgeMs: 7 * DAY_MS, maxPointBytes: MAX_POINT_BYTES });

      await expect(receive({ device: DEVICE, correlationId: CORRELATION_ID, envelope: envelope([point(E.ok1)]) })).rejects.toBeInstanceOf(PublicationFailedError);
    });

    it("el mensaje del error no incluye el del broker (que puede traer datos)", async () => {
      const { publisher, run } = setup();
      publisher.failAccepted = new Error("fallo con lat=6.2518");

      const failure = await run([point(E.ok1)]).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(PublicationFailedError);
      expect(failure instanceof Error ? failure.message : "").not.toContain("6.2518");
    });
  });
});
