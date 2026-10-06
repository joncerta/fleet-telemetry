import { randomUUID } from "node:crypto";
import { alertEventSchema, vehicleStateEventSchema, type AlertEvent, type VehicleStateEvent } from "@fleet/contracts";
import { createAdmin, createConsumer, createKafka, createLogger, createProducer, getCorrelationId, kafkaConfig, loadConfig } from "@fleet/platform";
import { createTempTopic, type TempTopic } from "@fleet/platform/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createKafkaFleetEventPublisher } from "./kafka-fleet-event-publisher.js";

// Contra Redpanda real: tópicos temporales (nunca vehicle.state ni fleet.alerts) con 3 particiones, el productor idempotente de la
// plataforma y un consumer que lee lo publicado. Comprueba lo que un fake no ve: que el broker confirma, la key, el header y el
// reparto por partición (misma key, misma partición, en orden).
const config = loadConfig(z.object(kafkaConfig.shape));
const logger = createLogger({ service: "fleet-event-publisher-it", level: "error" });
const kafka = createKafka({ brokers: config.KAFKA_BROKERS, clientId: "fleet-event-publisher-it", logger });
const admin = createAdmin(kafka);
const producer = createProducer(kafka, { retry: { retries: 1, initialRetryTime: 50, maxRetryTime: 200 } });

const TENANT = randomUUID();
let stateTopic: TempTopic;
let alertsTopic: TempTopic;

beforeAll(async () => {
  await admin.connect();
  await producer.connect();
  stateTopic = await createTempTopic(admin, 3);
  alertsTopic = await createTempTopic(admin, 3);
});

afterAll(async () => {
  await producer.disconnect().catch(() => undefined);
  await Promise.all([stateTopic?.drop().catch(() => undefined), alertsTopic?.drop().catch(() => undefined)]);
  await admin.disconnect().catch(() => undefined);
});

const stateEvent = (vehicleId: string, seq: number): VehicleStateEvent => ({
  schemaVersion: 1,
  tenantId: TENANT,
  state: {
    vehicleId,
    plate: "ABC123",
    lon: -75.5636,
    lat: 6.2518,
    recordedAt: new Date(Date.now() - 60_000).toISOString(),
    receivedAt: new Date().toISOString(),
    speedMps: 0,
    headingDeg: null,
    movement: "stopped",
    stoppedSince: new Date(Date.now() - 30 * 60_000).toISOString(),
    zoneIds: [],
    mocked: false,
    lowAccuracy: false,
    seq: String(seq),
  },
});

const alertEvent = (vehicleId: string, seq: number): AlertEvent => ({
  schemaVersion: 1,
  tenantId: TENANT,
  alert: {
    alertId: randomUUID(),
    vehicleId,
    plate: "ABC123",
    type: "mocked_location",
    zoneId: null,
    zoneName: null,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    raisedAt: new Date().toISOString(),
    resolvedAt: null,
    seq: String(seq),
  },
});

interface Seen<T> {
  key: string | undefined;
  correlationId: string | undefined;
  partition: number;
  offset: string;
  event: T;
}

async function waitFor<T>(what: string, probe: () => T | undefined | false, timeoutMs = 25_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = probe();
    if (result !== undefined && result !== false) return result;
    if (Date.now() > deadline) throw new Error(`Se agotaron ${timeoutMs} ms esperando: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Lee un tópico desde el principio con un grupo propio; devuelve lo visto y un `stop`. */
async function readTopic<T>(topic: string, parse: (value: unknown) => T): Promise<{ seen: Seen<T>[]; stop(): Promise<void> }> {
  const groupId = `fleet-event-publisher-it-${randomUUID().slice(0, 8)}`;
  const consumer = createConsumer(kafka, { groupId });
  const seen: Seen<T>[] = [];
  await consumer.connect();
  await consumer.subscribe({ topic, fromBeginning: true });
  await consumer.run({
    eachMessage: ({ message, partition }) => {
      seen.push({
        key: message.key?.toString(),
        correlationId: getCorrelationId(message.headers),
        partition,
        offset: message.offset,
        event: parse(JSON.parse(message.value?.toString() ?? "null")),
      });
      return Promise.resolve();
    },
  });
  return {
    seen,
    stop: async () => {
      await consumer.disconnect().catch(() => undefined);
      await admin.deleteGroups([groupId]).catch(() => undefined);
    },
  };
}

describe("createKafkaFleetEventPublisher contra Redpanda", () => {
  it("publica estado y alertas confirmados por el broker, con key = vehicleId, header correlationId y el evento que cumple el contrato", async () => {
    const publisher = createKafkaFleetEventPublisher({ producer, timeoutMs: 10_000, topics: { vehicleState: stateTopic.name, fleetAlerts: alertsTopic.name } });
    const vehicleA = randomUUID();
    const vehicleB = randomUUID();
    const states = await readTopic(stateTopic.name, (value) => vehicleStateEventSchema.parse(value));
    const alerts = await readTopic(alertsTopic.name, (value) => alertEventSchema.parse(value));
    try {
      await publisher.publish({
        vehicleStates: [
          { key: vehicleA, correlationId: "it-corr-a", event: stateEvent(vehicleA, 1) },
          { key: vehicleB, correlationId: "it-corr-b", event: stateEvent(vehicleB, 2) },
        ],
        alerts: [{ key: vehicleA, correlationId: "it-corr-c", event: alertEvent(vehicleA, 3) }],
      });

      await waitFor("los dos estados y la alerta", () => states.seen.length >= 2 && alerts.seen.length >= 1);
      const stateOfA = states.seen.find((entry) => entry.key === vehicleA);
      const stateOfB = states.seen.find((entry) => entry.key === vehicleB);
      expect(stateOfA).toMatchObject({ correlationId: "it-corr-a", event: { tenantId: TENANT, state: { vehicleId: vehicleA, seq: "1" } } });
      expect(stateOfB).toMatchObject({ correlationId: "it-corr-b", event: { state: { vehicleId: vehicleB, seq: "2" } } });
      expect(alerts.seen[0]).toMatchObject({ key: vehicleA, correlationId: "it-corr-c", event: { alert: { vehicleId: vehicleA, seq: "3" } } });
    } finally {
      await Promise.all([states.stop(), alerts.stop()]);
    }
  });

  it("misma key, misma partición y en orden: los estados de un vehículo llegan con el seq creciente", async () => {
    const publisher = createKafkaFleetEventPublisher({ producer, timeoutMs: 10_000, topics: { vehicleState: stateTopic.name, fleetAlerts: alertsTopic.name } });
    const vehicle = randomUUID();
    const states = await readTopic(stateTopic.name, (value) => vehicleStateEventSchema.parse(value));
    try {
      await publisher.publish({
        vehicleStates: [1, 2, 3, 4, 5].map((seq) => ({ key: vehicle, correlationId: `it-order-${seq}`, event: stateEvent(vehicle, seq) })),
        alerts: [],
      });

      const mine = await waitFor("los cinco estados del vehículo", () => {
        const found = states.seen.filter((entry) => entry.key === vehicle);
        return found.length >= 5 ? found : undefined;
      });
      expect(new Set(mine.map((entry) => entry.partition)).size).toBe(1);
      expect(mine.map((entry) => entry.event.state.seq)).toEqual(["1", "2", "3", "4", "5"]);
    } finally {
      await states.stop();
    }
  });

  it("un tramo grande se parte en sub-lotes y llega entero", async () => {
    const publisher = createKafkaFleetEventPublisher({
      producer,
      timeoutMs: 10_000,
      maxBatchBytes: 4_000,
      topics: { vehicleState: stateTopic.name, fleetAlerts: alertsTopic.name },
    });
    const vehicles = Array.from({ length: 30 }, () => randomUUID());
    const states = await readTopic(stateTopic.name, (value) => vehicleStateEventSchema.parse(value));
    try {
      await publisher.publish({ vehicleStates: vehicles.map((vehicle, i) => ({ key: vehicle, correlationId: `it-big-${i}`, event: stateEvent(vehicle, 100 + i) })), alerts: [] });

      await waitFor("los 30 estados", () => vehicles.every((vehicle) => states.seen.some((entry) => entry.key === vehicle)));
      const expected = new Set<string>(vehicles);
      expect(states.seen.filter((entry) => expected.has(entry.key ?? "")).length).toBe(30);
    } finally {
      await states.stop();
    }
  });

  it("un tópico que no existe hace rechazar la publicación (no resuelve a medias)", async () => {
    const publisher = createKafkaFleetEventPublisher({
      producer,
      timeoutMs: 5_000,
      topics: { vehicleState: `fleet-it-noexiste${randomUUID().replaceAll("-", "").slice(0, 6)}`, fleetAlerts: alertsTopic.name },
    });
    const vehicle = randomUUID();

    await expect(publisher.publish({ vehicleStates: [{ key: vehicle, correlationId: "it-missing", event: stateEvent(vehicle, 1) }], alerts: [] })).rejects.toThrow();
  });
});
