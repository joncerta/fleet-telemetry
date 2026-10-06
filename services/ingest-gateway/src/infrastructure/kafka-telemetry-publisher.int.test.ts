import { randomUUID } from "node:crypto";
import { telemetryDlqMessageSchema, telemetryRawEventSchema, type TelemetryDlqMessage, type TelemetryRawEvent } from "@fleet/contracts";
import {
  createAdmin,
  createConsumer,
  createKafka,
  createLogger,
  createProducer,
  getCorrelationId,
  kafkaConfig,
  loadConfig,
  type FleetProducer,
} from "@fleet/platform";
import { createTempTopic, type TempTopic } from "@fleet/platform/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createKafkaTelemetryPublisher } from "./kafka-telemetry-publisher.js";

// Contra Redpanda real, con tópicos temporales (nunca los reales) y el productor idempotente de la plataforma.
const config = loadConfig(z.object(kafkaConfig.shape));
const logger = createLogger({ service: "gateway-publisher-it", level: "error" });
const kafka = createKafka({ brokers: config.KAFKA_BROKERS, clientId: "gateway-publisher-it", logger });

const admin = createAdmin(kafka);
let rawTopic: TempTopic;
let dlqTopic: TempTopic;
let producer: FleetProducer;

beforeAll(async () => {
  await admin.connect();
  [rawTopic, dlqTopic] = await Promise.all([createTempTopic(admin, 3), createTempTopic(admin, 1)]);
  producer = createProducer(kafka, { retry: { retries: 1, initialRetryTime: 50, maxRetryTime: 200 } });
  await producer.connect();
});

afterAll(async () => {
  await producer?.disconnect();
  await Promise.all([rawTopic?.drop(), dlqTopic?.drop()]);
  await admin.disconnect();
});

interface Received {
  key: string | undefined;
  value: unknown;
  correlationId: string | undefined;
  partition: number;
}

/** Lee `expected` mensajes del tópico desde el principio con un grupo de un solo uso. */
async function readMessages(topic: string, expected: number): Promise<Received[]> {
  const groupId = `gateway-publisher-it-${randomUUID().slice(0, 8)}`;
  const consumer = createConsumer(kafka, { groupId });
  const received: Received[] = [];
  try {
    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning: true });
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timeout: llegaron ${received.length} de ${expected} mensajes a ${topic}`)), 25_000);
      void consumer
        .run({
          eachMessage: ({ message, partition }) => {
            received.push({
              key: message.key?.toString(),
              value: JSON.parse(message.value?.toString() ?? "null") as unknown,
              correlationId: getCorrelationId(message.headers),
              partition,
            });
            if (received.length >= expected) {
              clearTimeout(timer);
              resolve();
            }
            return Promise.resolve();
          },
        })
        .catch(reject);
    });
    await done;
  } finally {
    await consumer.disconnect().catch(() => undefined);
    await admin.deleteGroups([groupId]).catch(() => undefined);
  }
  return received;
}

const tenantId = randomUUID();
const deviceId = randomUUID();

const rawEvent = (vehicleId: string): TelemetryRawEvent => ({
  schemaVersion: 1,
  tenantId,
  deviceId,
  receivedAt: new Date().toISOString(),
  point: {
    eventId: randomUUID(),
    vehicleId,
    recordedAt: new Date(Date.now() - 1_000).toISOString(),
    lon: -75.5636,
    lat: 6.2518,
    speedMps: 10,
    headingDeg: 90,
    accuracyM: 5,
    mocked: false,
    lowAccuracy: false,
  },
});

const dlqMessage = (vehicleId: string): TelemetryDlqMessage => ({
  schemaVersion: 1,
  source: "ingest-gateway",
  reason: { code: "invalid_schema", message: "Campos inválidos: lat." },
  failedAt: new Date().toISOString(),
  tenantId,
  deviceId,
  vehicleId,
  eventId: randomUUID(),
  attempts: 0,
  originalPayload: { eventId: "no-uuid", lat: 999 },
});

describe("createKafkaTelemetryPublisher contra Redpanda", () => {
  it("publishAccepted: los mensajes llegan con key = vehicleId, header correlationId y un evento válido; los de un vehículo van a la misma partición", async () => {
    const publisher = createKafkaTelemetryPublisher({ producer, timeoutMs: 10_000, maxInFlight: 100, topics: { raw: rawTopic.name, dlq: dlqTopic.name } });
    const vehicleId = randomUUID();
    const otherVehicle = randomUUID();
    const correlationId = `it-raw-${randomUUID()}`;
    const events = [rawEvent(vehicleId), rawEvent(vehicleId), rawEvent(vehicleId)];

    await publisher.publishAccepted({ vehicleId, correlationId }, events);
    await publisher.publishAccepted({ vehicleId: otherVehicle, correlationId: "it-raw-other" }, [rawEvent(otherVehicle)]);

    const messages = (await readMessages(rawTopic.name, 4)).filter((message) => message.key === vehicleId);
    expect(messages).toHaveLength(3);
    expect(messages.map((message) => message.correlationId)).toEqual([correlationId, correlationId, correlationId]);
    expect(new Set(messages.map((message) => message.partition)).size).toBe(1);
    const published = messages.map((message) => telemetryRawEventSchema.parse(message.value));
    expect(published.map((event) => event.point.eventId).sort()).toEqual(events.map((event) => event.point.eventId).sort());
    expect(published.every((event) => event.tenantId === tenantId && event.deviceId === deviceId)).toBe(true);
  });

  it("publishRejected: el mensaje de la DLQ llega con key = vehicleId, correlationId, motivo y el payload original intactos", async () => {
    const publisher = createKafkaTelemetryPublisher({ producer, timeoutMs: 10_000, maxInFlight: 100, topics: { raw: rawTopic.name, dlq: dlqTopic.name } });
    const vehicleId = randomUUID();
    const correlationId = `it-dlq-${randomUUID()}`;
    const message = dlqMessage(vehicleId);

    await publisher.publishRejected({ vehicleId, correlationId }, [message]);

    const [received] = await readMessages(dlqTopic.name, 1);
    expect(received?.key).toBe(vehicleId);
    expect(received?.correlationId).toBe(correlationId);
    expect(telemetryDlqMessageSchema.parse(received?.value)).toEqual(message);
  });

  it("un tópico que no existe (no hay autocreación) rechaza la publicación en vez de tragarla", async () => {
    const publisher = createKafkaTelemetryPublisher({ producer, timeoutMs: 10_000, maxInFlight: 100, topics: { raw: `fleet-it-${"0".repeat(12)}`, dlq: dlqTopic.name } });
    const vehicleId = randomUUID();

    await expect(publisher.publishAccepted({ vehicleId, correlationId: "it-missing" }, [rawEvent(vehicleId)])).rejects.toThrow();
  });
});

describe("lotes grandes de rechazos contra Redpanda", () => {
  const bigDlqMessage = (vehicleId: string, bytes: number): TelemetryDlqMessage => ({
    ...dlqMessage(vehicleId),
    originalPayload: { eventId: "no-uuid", relleno: "x".repeat(bytes) },
  });

  it("500 rechazos grandes (cerca de 1 MiB en total) llegan completos a la DLQ, repartidos en sub-lotes y en orden", async () => {
    // Tópico propio: el conteo de mensajes no depende de lo que publiquen los otros tests.
    const bigTopic = await createTempTopic(admin, 1);
    const publisher = createKafkaTelemetryPublisher({ producer, timeoutMs: 20_000, maxInFlight: 100, topics: { raw: rawTopic.name, dlq: bigTopic.name } });
    const vehicleId = randomUUID();
    const correlationId = `it-dlq-big-${randomUUID()}`;
    const messages = Array.from({ length: 500 }, () => bigDlqMessage(vehicleId, 2_000));
    const totalBytes = messages.reduce((total, message) => total + Buffer.byteLength(JSON.stringify(message)), 0);
    expect(totalBytes).toBeGreaterThan(1_000_000);

    try {
      await publisher.publishRejected({ vehicleId, correlationId }, messages);

      const received = await readMessages(bigTopic.name, 500);
      expect(received).toHaveLength(500);
      expect(received.every((message) => message.correlationId === correlationId && message.key === vehicleId)).toBe(true);
      expect(received.map((message) => telemetryDlqMessageSchema.parse(message.value).eventId)).toEqual(messages.map((message) => message.eventId));
    } finally {
      await bigTopic.drop().catch(() => undefined);
    }
  }, 60_000);
});
