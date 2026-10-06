import { alertEventSchema, TOPICS, vehicleStateEventSchema, type AlertEvent, type VehicleStateEvent } from "@fleet/contracts";
import { CORRELATION_ID_HEADER, type FleetProducer, type FleetSendBatch } from "@fleet/platform";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KeyedEvent } from "../application/ports.js";
import { createKafkaFleetEventPublisher } from "./kafka-fleet-event-publisher.js";
import { PublishTimeoutError } from "./publish-timeout.js";

const TENANT = "9d7e1b34-2a6c-4f08-b5d3-6e4a8c1f0b92";
const VEHICLE = "a1c4e9d2-7b3f-4c58-8e16-0d9f2b6a4c71";
const ZONE = "11111111-1111-4111-8111-111111111111";

const stateEvent = (seq = "7", vehicleId = VEHICLE): VehicleStateEvent => ({
  schemaVersion: 1,
  tenantId: TENANT,
  state: {
    vehicleId,
    plate: "ABC123",
    lon: -75.5636,
    lat: 6.2518,
    recordedAt: "2026-03-14T19:59:30.000Z",
    receivedAt: "2026-03-14T20:00:00.000Z",
    speedMps: 0,
    headingDeg: null,
    movement: "stopped",
    stoppedSince: "2026-03-14T19:30:00.000Z",
    zoneIds: [ZONE],
    mocked: false,
    lowAccuracy: false,
    seq,
  },
});

const alertEvent = (seq = "8"): AlertEvent => ({
  schemaVersion: 1,
  tenantId: TENANT,
  alert: {
    alertId: "4cf55448-3962-55da-8603-eccff932a311",
    vehicleId: VEHICLE,
    plate: "ABC123",
    type: "critical_zone_stop",
    zoneId: ZONE,
    zoneName: "Zona crítica",
    startedAt: "2026-03-14T19:30:00.000Z",
    raisedAt: "2026-03-14T20:00:00.000Z",
    resolvedAt: null,
    seq,
  },
});

const keyed = <T>(event: T, correlationId: string, key = VEHICLE): KeyedEvent<T> => ({ key, correlationId, event });

function fakeProducer(behavior: (call: number) => Promise<unknown> = () => Promise.resolve([])) {
  const batches: FleetSendBatch[] = [];
  const producer: Pick<FleetProducer, "sendBatch"> = {
    sendBatch: (batch) => {
      batches.push(batch);
      return behavior(batches.length).then(() => []);
    },
  };
  return { producer, batches };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createKafkaFleetEventPublisher", () => {
  it("publica el estado en vehicle.state y las alertas en fleet.alerts, con key = vehicleId, el correlationId de cada uno y el evento como JSON", async () => {
    const { producer, batches } = fakeProducer();
    const publisher = createKafkaFleetEventPublisher({ producer, timeoutMs: 5_000 });

    await publisher.publish({
      vehicleStates: [keyed(stateEvent("7"), "corr-a"), keyed(stateEvent("9", "b2d5f0e3-8c4a-4d69-9f27-1e0a3c7b5d82"), "corr-b", "b2d5f0e3-8c4a-4d69-9f27-1e0a3c7b5d82")],
      alerts: [keyed(alertEvent(), "corr-c")],
    });

    expect(batches.map((batch) => batch.topicMessages.map((entry) => entry.topic))).toEqual([[TOPICS.vehicleState], [TOPICS.fleetAlerts]]);
    const [states, alerts] = batches.map((batch) => batch.topicMessages[0]?.messages ?? []);
    expect(states?.map((m) => m.key)).toEqual([VEHICLE, "b2d5f0e3-8c4a-4d69-9f27-1e0a3c7b5d82"]);
    expect(states?.map((m) => m.headers[CORRELATION_ID_HEADER])).toEqual(["corr-a", "corr-b"]);
    expect(states?.map((m) => vehicleStateEventSchema.parse(JSON.parse(String(m.value))).state.seq)).toEqual(["7", "9"]);
    expect(alerts?.map((m) => m.key)).toEqual([VEHICLE]);
    expect(alerts?.map((m) => m.headers[CORRELATION_ID_HEADER])).toEqual(["corr-c"]);
    expect(alertEventSchema.parse(JSON.parse(String(alerts?.[0]?.value)))).toEqual(alertEvent());
  });

  it("sin alertas no hace un envío vacío a fleet.alerts", async () => {
    const { producer, batches } = fakeProducer();

    await createKafkaFleetEventPublisher({ producer, timeoutMs: 5_000 }).publish({ vehicleStates: [keyed(stateEvent(), "corr-a")], alerts: [] });

    expect(batches).toHaveLength(1);
    expect(batches[0]?.topicMessages[0]?.topic).toBe(TOPICS.vehicleState);
  });

  it("usa los tópicos indicados (los tests de integración usan temporales)", async () => {
    const { producer, batches } = fakeProducer();

    await createKafkaFleetEventPublisher({ producer, timeoutMs: 5_000, topics: { vehicleState: "t-state", fleetAlerts: "t-alerts" } }).publish({
      vehicleStates: [keyed(stateEvent(), "corr-a")],
      alerts: [keyed(alertEvent(), "corr-a")],
    });

    expect(batches.map((batch) => batch.topicMessages[0]?.topic)).toEqual(["t-state", "t-alerts"]);
  });

  it("parte cada tópico en sub-lotes por tamaño, en orden y sin perder ningún evento", async () => {
    const { producer, batches } = fakeProducer();
    const events = Array.from({ length: 10 }, (_, i) => keyed(stateEvent(String(i + 1)), `corr-${i}`));

    await createKafkaFleetEventPublisher({ producer, timeoutMs: 5_000, maxBatchBytes: 1_500 }).publish({ vehicleStates: events, alerts: [] });

    expect(batches.length).toBeGreaterThan(1);
    const sent = batches.flatMap((batch) => batch.topicMessages.flatMap((entry) => entry.messages));
    expect(sent.map((m) => m.headers[CORRELATION_ID_HEADER])).toEqual(events.map((e) => e.correlationId));
    for (const batch of batches) expect(batch.timeout).toBe(5_000);
  });

  it("si un envío falla, no se envían los siguientes y el error sube", async () => {
    const failure = new Error("broker caído");
    const { producer, batches } = fakeProducer((call) => (call === 1 ? Promise.reject(failure) : Promise.resolve([])));

    await expect(
      createKafkaFleetEventPublisher({ producer, timeoutMs: 5_000 }).publish({ vehicleStates: [keyed(stateEvent(), "corr-a")], alerts: [keyed(alertEvent(), "corr-a")] }),
    ).rejects.toBe(failure);

    expect(batches).toHaveLength(1);
  });

  it("un evento que incumple el contrato estricto no se envía: rechaza antes de tocar el broker", async () => {
    const { producer, batches } = fakeProducer();
    const invalid = stateEvent("7");
    const broken: VehicleStateEvent = { ...invalid, state: { ...invalid.state, plate: "" } };

    await expect(createKafkaFleetEventPublisher({ producer, timeoutMs: 5_000 }).publish({ vehicleStates: [keyed(broken, "corr-a")], alerts: [] })).rejects.toThrow();

    expect(batches).toEqual([]);
  });

  it("un correlationId inválido rechaza como promesa (no lanza de forma síncrona)", async () => {
    const { producer } = fakeProducer();
    const publisher = createKafkaFleetEventPublisher({ producer, timeoutMs: 5_000 });

    await expect(publisher.publish({ vehicleStates: [keyed(stateEvent(), "con espacios\n")], alerts: [] })).rejects.toThrow();
  });

  it("con fake timers: si el broker no responde en timeoutMs rechaza con PublishTimeoutError", async () => {
    vi.useFakeTimers();
    const { producer } = fakeProducer(() => new Promise<never>(() => undefined));
    const publisher = createKafkaFleetEventPublisher({ producer, timeoutMs: 1_000 });

    const outcome = publisher.publish({ vehicleStates: [keyed(stateEvent(), "corr-a")], alerts: [] }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);

    const error = await outcome;
    expect(error).toBeInstanceOf(PublishTimeoutError);
    expect(error).toMatchObject({ timeoutMs: 1_000 });
  });

  it("vencido el tiempo no inicia envíos nuevos", async () => {
    vi.useFakeTimers();
    let resolveFirst: () => void = () => undefined;
    const { producer, batches } = fakeProducer((call) => (call === 1 ? new Promise<void>((resolve) => (resolveFirst = resolve)) : Promise.resolve([])));
    const publisher = createKafkaFleetEventPublisher({ producer, timeoutMs: 1_000 });

    const outcome = publisher.publish({ vehicleStates: [keyed(stateEvent(), "corr-a")], alerts: [keyed(alertEvent(), "corr-a")] }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await outcome).toBeInstanceOf(PublishTimeoutError);
    resolveFirst();
    await vi.advanceTimersByTimeAsync(10);

    expect(batches).toHaveLength(1);
  });
});
