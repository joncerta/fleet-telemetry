import { randomUUID } from "node:crypto";
import type { AlertEvent, VehicleStateEvent } from "@fleet/contracts";
import { createAdmin, createConsumer, createKafka, createLogger, createProducer, kafkaConfig, loadConfig, withCorrelationId } from "@fleet/platform";
import { createTempTopic, type TempTopic } from "@fleet/platform/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createFleetEventHub } from "../../application/fleet-event-hub.js";
import type { FleetStreamEvent } from "../../domain/stream-ordering.js";
import { createFleetEventFeed, type FleetEventFeed } from "./fleet-event-feed.js";

// Contra Redpanda real: tópicos y grupos temporales (nunca los reales) y TODA la cadena de producción del feed (consumer de la plataforma, admin que fija
// los offsets, parseo tolerante y hub en memoria).
const config = loadConfig(z.object({ ...kafkaConfig.shape }));
const logger = createLogger({ service: "fleet-api-feed-it", level: "error" });
const kafka = createKafka({ brokers: config.KAFKA_BROKERS, clientId: "fleet-api-feed-it", logger });
const admin = createAdmin(kafka);
const producer = createProducer(kafka, { retry: { retries: 1, initialRetryTime: 50, maxRetryTime: 200 } });

let stateTopic: TempTopic;
let alertsTopic: TempTopic;
const groups: string[] = [];

beforeAll(async () => {
  await admin.connect();
  await producer.connect();
  stateTopic = await createTempTopic(admin, 2);
  alertsTopic = await createTempTopic(admin, 1);
});

afterAll(async () => {
  await producer.disconnect().catch(() => undefined);
  await admin.deleteGroups(groups).catch(() => undefined);
  await Promise.all([stateTopic?.drop().catch(() => undefined), alertsTopic?.drop().catch(() => undefined)]);
  await admin.disconnect().catch(() => undefined);
});

const stateEvent = (tenantId: string, vehicleId: string = randomUUID(), seq = "10"): VehicleStateEvent => ({
  schemaVersion: 1,
  tenantId,
  state: {
    vehicleId,
    plate: "ABC123",
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
    seq,
  },
});

const alertEvent = (tenantId: string, vehicleId: string = randomUUID()): AlertEvent => ({
  schemaVersion: 1,
  tenantId,
  alert: {
    alertId: randomUUID(),
    vehicleId,
    plate: "ABC123",
    type: "critical_zone_stop",
    zoneId: null,
    zoneName: null,
    startedAt: "2026-10-06T11:30:00.000Z",
    raisedAt: "2026-10-06T11:50:00.000Z",
    resolvedAt: null,
    seq: "11",
  },
});

const send = (topic: TempTopic, key: string, value: string) =>
  producer.send({ topic: topic.name, messages: [{ key, value, headers: withCorrelationId(undefined, `it-${randomUUID().slice(0, 8)}`) }] });

/** Espera por sondeo, nunca con un sleep fijo. */
async function waitFor<T>(what: string, probe: () => T | undefined | false, timeoutMs = 25_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = probe();
    if (result !== undefined && result !== false) return result;
    if (Date.now() > deadline) throw new Error(`Se agotaron ${timeoutMs} ms esperando: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

interface Replica {
  feed: FleetEventFeed;
  groupId: string;
  /** Lo que llegó al fan-out de una suscripción a `tenantId`. */
  seen: Map<string, FleetStreamEvent[]>;
  listen(tenantId: string): FleetStreamEvent[];
}

/** Una "réplica": su propio consumer, su propio grupo y su propio hub, como dos procesos de fleet-api. */
function makeReplica(instanceId: string): Replica {
  const groupId = `fleet-api-sse-${instanceId}`;
  groups.push(groupId);
  const hub = createFleetEventHub({ logger });
  const seen = new Map<string, FleetStreamEvent[]>();
  const feed = createFleetEventFeed({
    consumer: createConsumer(kafka, { groupId }),
    groupId,
    topics: { vehicleState: stateTopic.name, fleetAlerts: alertsTopic.name },
    publish: hub.publish,
    logger,
  });
  return {
    feed,
    groupId,
    seen,
    listen(tenantId) {
      const events: FleetStreamEvent[] = [];
      seen.set(tenantId, events);
      hub.subscribe(tenantId, (event) => void events.push(event));
      return events;
    },
  };
}

/**
 * Un consumer de un grupo nuevo resuelve su posición ("el final") en su primer fetch, unos milisegundos después de unirse: un evento
 * producido en esa ventana no se vería. En producción es inocuo (el servidor no acepta streams hasta arrancar y cada snapshot se lee después);
 * en el test se espera a que un evento de sondeo (de un tenant que nadie más usa) llegue, y entonces el consumer está posicionado.
 */
async function warmUp(replica: Replica): Promise<void> {
  const probeTenant = randomUUID();
  const probes = replica.listen(probeTenant);
  await waitFor("el consumer posicionado (un evento de sondeo llega)", () => {
    if (probes.length > 0) return true;
    send(stateTopic, randomUUID(), JSON.stringify(stateEvent(probeTenant))).catch(() => undefined);
    return undefined;
  });
}

const TEST_TIMEOUT = 60_000;

describe("feed del SSE contra Redpanda", () => {
  it(
    "cada réplica tiene su grupo propio y recibe TODOS los eventos de vehicle.state y fleet.alerts de su tenant, sin reprocesar la historia; un mensaje inválido se descarta sin frenar a los siguientes",
    async () => {
      const tenantId = randomUUID();
      const otherTenant = randomUUID();
      // Historia anterior al arranque: no debe llegar a nadie (el grupo se fija al final de los tópicos).
      const history = stateEvent(tenantId);
      await send(stateTopic, history.state.vehicleId, JSON.stringify(history));

      const a = makeReplica(`it-a-${randomUUID().slice(0, 8)}`);
      const b = makeReplica(`it-b-${randomUUID().slice(0, 8)}`);
      const eventsA = a.listen(tenantId);
      const eventsB = b.listen(tenantId);
      const foreignA = a.listen(otherTenant);
      try {
        await a.feed.start();
        await b.feed.start();
        await warmUp(a);
        await warmUp(b);
        expect(a.feed.isReady()).toBe(true);
        expect(b.feed.isReady()).toBe(true);
        expect(a.groupId).not.toBe(b.groupId);

        const live = stateEvent(tenantId, randomUUID(), "21");
        const liveAlert = alertEvent(tenantId, live.state.vehicleId);
        const other = stateEvent(otherTenant, randomUUID(), "22");
        await send(stateTopic, live.state.vehicleId, JSON.stringify(live));
        await send(alertsTopic, live.state.vehicleId, JSON.stringify(liveAlert));
        await send(stateTopic, live.state.vehicleId, "{no es json");
        await send(alertsTopic, live.state.vehicleId, JSON.stringify({ hola: "mundo" }));
        await send(stateTopic, other.state.vehicleId, JSON.stringify(other));
        // Un evento válido DESPUÉS de los inválidos: prueba que la partición no se detuvo.
        const after = stateEvent(tenantId, live.state.vehicleId, "23");
        await send(stateTopic, live.state.vehicleId, JSON.stringify(after));

        for (const events of [eventsA, eventsB]) {
          await waitFor("los tres eventos válidos del tenant", () => events.length >= 3 && events);
        }
        await waitFor("el evento del otro tenant en la réplica A", () => foreignA.length >= 1 && foreignA);

        for (const events of [eventsA, eventsB]) {
          expect(events).toHaveLength(3);
          const stateSeqs = events.flatMap((event) => (event.type === "vehicle.state" ? [event.state.seq] : []));
          expect(stateSeqs).toEqual(["21", "23"]);
          expect(events.filter((event) => event.type === "alert")).toEqual([{ type: "alert", alert: liveAlert.alert }]);
          // Sin historia: el evento previo al arranque no llegó.
          expect(events.some((event) => event.type === "vehicle.state" && event.state.vehicleId === history.state.vehicleId)).toBe(false);
        }
        // El tenant ajeno recibió solo lo suyo (el fan-out por tenant lo hace el hub; el feed entrega por el tenantId del payload).
        expect(foreignA).toEqual([{ type: "vehicle.state", state: other.state }]);

        const { groups: listed } = await admin.listGroups();
        const ids = listed.map((group) => group.groupId);
        expect(ids).toContain(a.groupId);
        expect(ids).toContain(b.groupId);
      } finally {
        await a.feed.stop().catch(() => undefined);
        await b.feed.stop().catch(() => undefined);
      }
    },
    TEST_TIMEOUT,
  );

  it(
    "tras stop() el feed deja de estar listo y no entrega más",
    async () => {
      const tenantId = randomUUID();
      const replica = makeReplica(`it-stop-${randomUUID().slice(0, 8)}`);
      const events = replica.listen(tenantId);
      await replica.feed.start();
      await warmUp(replica);
      await replica.feed.stop();

      await send(stateTopic, randomUUID(), JSON.stringify(stateEvent(tenantId)));
      // Ventana negativa a propósito (no hay evento que esperar): detenido, no entrega nada.
      await new Promise((resolve) => setTimeout(resolve, 1_500));

      expect(replica.feed.isReady()).toBe(false);
      expect(events).toEqual([]);
    },
    TEST_TIMEOUT,
  );
});
