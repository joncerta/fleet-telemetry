import { randomUUID } from "node:crypto";
import type { AlertEvent, VehicleStateEvent } from "@fleet/contracts";
import { createLogger } from "@fleet/platform";
import { describe, expect, it, vi } from "vitest";
import type { FleetStreamEvent } from "../../domain/stream-ordering.js";
import { createFleetEventFeed, FEED_AUTO_COMMIT_INTERVAL_MS, type FeedConsumerEvent, type FeedConsumerPort, type FeedMessage } from "./fleet-event-feed.js";

const TOPICS = { vehicleState: "vehicle.state", fleetAlerts: "fleet.alerts" } as const;
const GROUP = "fleet-api-sse-test";
const PLATE = "PLACA-SECRETA";

const stateEvent = (tenantId: string, overrides: Record<string, unknown> = {}): VehicleStateEvent => ({
  schemaVersion: 1,
  tenantId,
  state: {
    vehicleId: randomUUID(),
    plate: PLATE,
    lon: -75.5636,
    lat: 6.2518,
    recordedAt: "2026-10-06T11:59:00.000Z",
    receivedAt: "2026-10-06T11:59:01.000Z",
    speedMps: 0,
    headingDeg: null,
    movement: "stopped",
    stoppedSince: "2026-10-06T11:30:00.000Z",
    zoneIds: [],
    mocked: false,
    lowAccuracy: false,
    seq: "10",
    ...overrides,
  },
});

const alertEvent = (tenantId: string): AlertEvent => ({
  schemaVersion: 1,
  tenantId,
  alert: {
    alertId: randomUUID(),
    vehicleId: randomUUID(),
    plate: PLATE,
    type: "critical_zone_stop",
    zoneId: null,
    zoneName: null,
    startedAt: "2026-10-06T11:30:00.000Z",
    raisedAt: "2026-10-06T11:50:00.000Z",
    resolvedAt: null,
    seq: "11",
  },
});

const messageOf = (topic: string, value: unknown, offset = "0"): FeedMessage => ({
  topic,
  partition: 0,
  message: { offset, value: Buffer.from(typeof value === "string" ? value : JSON.stringify(value)) },
});

function makeFeed() {
  const calls: string[] = [];
  let connectError: Error | undefined;
  const listeners = new Map<string, (event: FeedConsumerEvent) => void>();
  let eachMessage: ((payload: FeedMessage) => Promise<void>) | undefined;
  const runConfigs: { autoCommit: boolean; autoCommitInterval: number }[] = [];
  const consumer: FeedConsumerPort = {
    events: { GROUP_JOIN: "consumer.group_join", REBALANCING: "consumer.rebalancing", CRASH: "consumer.crash" },
    on: (event, listener) => void listeners.set(event, listener),
    connect: () => (connectError === undefined ? Promise.resolve(void calls.push("consumer.connect")) : Promise.reject(connectError)),
    subscribe: ({ topic, fromBeginning }) => Promise.resolve(void calls.push(`subscribe ${topic} fromBeginning=${String(fromBeginning)}`)),
    run: (config) => {
      calls.push("consumer.run");
      eachMessage = config.eachMessage;
      runConfigs.push({ autoCommit: config.autoCommit, autoCommitInterval: config.autoCommitInterval });
      return Promise.resolve();
    },
    stop: () => Promise.resolve(void calls.push("consumer.stop")),
    disconnect: () => Promise.resolve(void calls.push("consumer.disconnect")),
  };
  const published: { tenantId: string; event: FleetStreamEvent }[] = [];
  const publish = vi.fn((tenantId: string, event: FleetStreamEvent) => void published.push({ tenantId, event }));
  const lines: string[] = [];
  const logger = createLogger({ service: "fleet-api-test", level: "debug", destination: { write: (line: string) => void lines.push(line) } });
  const onFatal = vi.fn<(reason: string) => void>();
  const feed = createFleetEventFeed({ consumer, groupId: GROUP, topics: TOPICS, publish, logger, onFatal });
  const deliver = (message: FeedMessage) => {
    if (eachMessage === undefined) throw new Error("el feed no ha arrancado");
    return eachMessage(message);
  };
  const emit = (event: string, type: string, payload: unknown = {}) => listeners.get(event)?.({ type, payload });
  return { feed, calls, runConfigs, onFatal, failConnect: (error: Error) => void (connectError = error), published, publish, deliver, emit, logs: () => lines.join("") };
}

describe("arranque", () => {
  it("conecta, se suscribe a los dos tópicos DESDE EL FINAL (sin reprocesar historia) y consume; solo entonces está listo", async () => {
    const { feed, calls } = makeFeed();

    await feed.start();

    expect(calls).toEqual(["consumer.connect", "subscribe vehicle.state fromBeginning=false", "subscribe fleet.alerts fromBeginning=false", "consumer.run"]);
    expect(feed.isReady()).toBe(true);
  });

  it("confirma la posición del grupo por intervalo (no por mensaje)", async () => {
    const { feed, runConfigs } = makeFeed();

    await feed.start();

    expect(runConfigs).toEqual([{ autoCommit: true, autoCommitInterval: FEED_AUTO_COMMIT_INTERVAL_MS }]);
  });

  it("si conectar o suscribirse falla, el arranque falla y el feed no queda listo", async () => {
    const { feed, failConnect } = makeFeed();
    failConnect(new Error("broker no disponible"));

    await expect(feed.start()).rejects.toThrow("broker no disponible");

    expect(feed.isReady()).toBe(false);
  });
});

describe("eventos válidos", () => {
  it("vehicle.state: se entrega al tenant del PAYLOAD con el estado del contrato", async () => {
    const { feed, deliver, published } = makeFeed();
    await feed.start();
    const tenantId = randomUUID();
    const event = stateEvent(tenantId);

    await deliver(messageOf(TOPICS.vehicleState, event));

    expect(published).toEqual([{ tenantId, event: { type: "vehicle.state", state: event.state } }]);
  });

  it("fleet.alerts: se entrega al tenant del payload con la alerta del contrato", async () => {
    const { feed, deliver, published } = makeFeed();
    await feed.start();
    const tenantId = randomUUID();
    const event = alertEvent(tenantId);

    await deliver(messageOf(TOPICS.fleetAlerts, event));

    expect(published).toEqual([{ tenantId, event: { type: "alert", alert: event.alert } }]);
  });

  it("lee con el esquema TOLERANTE: un movement desconocido llega como unknown y una schemaVersion futura se acepta", async () => {
    const { feed, deliver, published } = makeFeed();
    await feed.start();
    const tenantId = randomUUID();

    await deliver(messageOf(TOPICS.vehicleState, { ...stateEvent(tenantId, { movement: "parked" }), schemaVersion: 2 }));

    expect(published).toHaveLength(1);
    expect(published[0]?.event).toMatchObject({ type: "vehicle.state", state: { movement: "unknown" } });
  });
});

describe("eventos inválidos", () => {
  it.each([
    ["no es JSON", "{no es json"],
    ["un valor nulo", "null"],
    ["sin tenantId", JSON.stringify({ ...stateEvent(randomUUID()), tenantId: undefined })],
    ["con un seq inválido", JSON.stringify(stateEvent(randomUUID(), { seq: "abc" }))],
    ["con una estructura ajena", JSON.stringify({ hola: "mundo" })],
  ])("%s: se descarta sin entregar, sin lanzar y sin volcar el contenido al log", async (_label, value) => {
    const { feed, deliver, published, logs } = makeFeed();
    await feed.start();

    await expect(deliver(messageOf(TOPICS.vehicleState, value, "42"))).resolves.toBeUndefined();

    expect(published).toEqual([]);
    expect(logs()).toContain("Mensaje descartado");
    expect(logs()).toContain('"offset":"42"');
    for (const forbidden of [PLATE, "-75.5636", "6.2518"]) expect(logs()).not.toContain(forbidden);
  });

  it("un mensaje sin valor (tombstone) se descarta", async () => {
    const { feed, deliver, published } = makeFeed();
    await feed.start();

    await deliver({ topic: TOPICS.fleetAlerts, partition: 0, message: { offset: "1", value: null } });

    expect(published).toEqual([]);
  });

  it("si repartir el evento lanza, eachMessage no propaga el error (kafkajs no debe reiniciar el consumer) y queda registrado", async () => {
    const { feed, deliver, publish, logs } = makeFeed();
    publish.mockImplementationOnce(() => {
      throw new Error("falla del hub");
    });
    await feed.start();

    await expect(deliver(messageOf(TOPICS.vehicleState, stateEvent(randomUUID())))).resolves.toBeUndefined();

    expect(logs()).toContain("Falló el reparto");
  });
});

describe("CRASH: un consumer caído sin reinicio deja un proceso vivo que no entrega eventos", () => {
  const crash = (restart: unknown) => ({ error: new Error("el consumer se cayó"), groupId: GROUP, restart });

  it("con restart: false llama a onFatal para que el proceso se apague y el orquestador lo reinicie", async () => {
    const { feed, emit, onFatal, logs } = makeFeed();
    await feed.start();

    emit("consumer.crash", "consumer.crash", crash(false));

    expect(onFatal).toHaveBeenCalledOnce();
    expect(onFatal).toHaveBeenCalledWith(expect.stringMatching(/consumer/i));
    expect(feed.isReady()).toBe(false);
    expect(logs()).toContain("NO lo reinicia");
  });

  it("con restart: true kafkajs ya lo reinicia: solo deja de estar listo, sin apagar el proceso", async () => {
    const { feed, emit, onFatal } = makeFeed();
    await feed.start();

    emit("consumer.crash", "consumer.crash", crash(true));

    expect(onFatal).not.toHaveBeenCalled();
    expect(feed.isReady()).toBe(false);
  });

  // Falla en cerrado: si no se puede leer el payload no se sabe si kafkajs reinicia, y es preferible reiniciar el proceso.
  it.each([
    ["sin restart", { error: new Error("x"), groupId: GROUP }],
    ["restart que no es booleano", crash("true")],
    ["error como texto", { error: "texto", groupId: GROUP, restart: true }],
    ["sin payload", undefined],
  ])("con un payload ilegible (%s) llama a onFatal", async (_label, payload) => {
    const { feed, emit, onFatal } = makeFeed();
    await feed.start();

    emit("consumer.crash", "consumer.crash", payload);

    expect(onFatal).toHaveBeenCalledOnce();
  });

  it("un evento de otro tipo en CRASH se ignora", async () => {
    const { feed, emit, onFatal } = makeFeed();
    await feed.start();

    emit("consumer.crash", "otro.evento", crash(false));

    expect(onFatal).not.toHaveBeenCalled();
  });
});

describe("estado de salud", () => {
  it("no está listo antes de arrancar, lo está al arrancar, cae con un rebalanceo o un crash y vuelve al unirse al grupo", async () => {
    const { feed, emit } = makeFeed();
    expect(feed.isReady()).toBe(false);

    await feed.start();
    expect(feed.isReady()).toBe(true);

    emit("consumer.rebalancing", "consumer.rebalancing");
    expect(feed.isReady()).toBe(false);
    emit("consumer.group_join", "consumer.group_join");
    expect(feed.isReady()).toBe(true);

    emit("consumer.crash", "consumer.crash", { error: new Error("x"), groupId: GROUP, restart: true });
    expect(feed.isReady()).toBe(false);
    emit("consumer.group_join", "consumer.group_join");
    expect(feed.isReady()).toBe(true);
  });

  it("stop deja de consumir, desconecta y deja de estar listo", async () => {
    const { feed, calls } = makeFeed();
    await feed.start();

    await feed.stop();

    expect(calls.slice(-2)).toEqual(["consumer.stop", "consumer.disconnect"]);
    expect(feed.isReady()).toBe(false);
  });
});
