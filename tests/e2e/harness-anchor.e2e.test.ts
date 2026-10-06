import { randomUUID } from "node:crypto";
import { createAdmin, createConsumer, createKafka, createLogger, createProducer, loadConfig, type FleetProducer } from "@fleet/platform";
import { createTempTopic, type TempTopic } from "@fleet/platform/testing";
import type { Admin, Consumer } from "kafkajs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pinGroupToTopicEnd } from "./harness.js";
import { e2eConfigSchema } from "./support.js";

// `pinGroupToTopicEnd` es lo que impide que el grupo del processor del e2e mastique el backlog de corridas anteriores. El smoke
// (services-smoke) lo comprueba contra `telemetry.raw`, pero en un CI con el tópico vacío no hay backlog que mastique y ese test pasa
// aunque el anclaje no haga nada. Aquí la precondición se fabrica: un tópico temporal con backlog.
const config = loadConfig(e2eConfigSchema);
const PARTITIONS = 3;
const BACKLOG = 9;
const AFTER = 3;

const kafka = createKafka({
  brokers: config.KAFKA_BROKERS,
  clientId: `e2e-harness-anchor-${randomUUID().slice(0, 8)}`,
  logger: createLogger({ service: "e2e-harness-anchor", level: "error" }),
});
const runId = randomUUID().replaceAll("-", "").slice(0, 12);
const pinnedGroup = `e2e-anchor-pinned-${runId}`;
const controlGroup = `e2e-anchor-control-${runId}`;

let admin: Admin;
let producer: FleetProducer;
let topic: TempTopic;
const consumers: Consumer[] = [];

beforeAll(async () => {
  admin = createAdmin(kafka);
  await admin.connect();
  topic = await createTempTopic(admin, PARTITIONS);
  producer = createProducer(kafka);
  await producer.connect();
});

afterAll(async () => {
  await Promise.all(consumers.map((consumer) => consumer.disconnect().catch(() => undefined)));
  await producer?.disconnect().catch(() => undefined);
  await admin?.deleteGroups([pinnedGroup, controlGroup]).catch(() => undefined);
  await topic?.drop().catch(() => undefined);
  await admin?.disconnect().catch(() => undefined);
});

async function produce(label: string, count: number): Promise<string[]> {
  const values = Array.from({ length: count }, (_, i) => `${label}-${i}`);
  await producer.send({
    topic: topic.name,
    messages: values.map((value) => ({ key: value, value, headers: { correlationId: `e2e-anchor-${runId}` } })),
  });
  return values;
}

async function totalMessages(): Promise<number> {
  const offsets = await admin.fetchTopicOffsets(topic.name);
  return offsets.reduce((sum, { low, high }) => sum + (Number(high) - Number(low)), 0);
}

/** Consumer `fromBeginning` de un grupo que recoge los valores que ve, y una función que espera a haber visto los esperados. */
async function startReader(groupId: string) {
  const consumer = createConsumer(kafka, { groupId });
  consumers.push(consumer);
  await consumer.connect();
  await consumer.subscribe({ topic: topic.name, fromBeginning: true });
  const seen: string[] = [];
  await consumer.run({
    eachMessage: ({ message }) => {
      seen.push(message.value?.toString() ?? "");
      return Promise.resolve();
    },
  });
  return {
    seen,
    waitUntilSeen: (expected: readonly string[]) =>
      vi.waitFor(() => expect(expected.filter((value) => !seen.includes(value))).toEqual([]), { timeout: 20_000, interval: 100 }),
  };
}

describe("pinGroupToTopicEnd contra un tópico con backlog", () => {
  it("un consumer fromBeginning del grupo anclado solo ve lo producido después; sin anclar, ve también el backlog", async () => {
    const backlog = await produce("backlog", BACKLOG);
    // Precondición: sin backlog el test no probaría nada. Se exige y no se supone.
    expect(await totalMessages()).toBe(BACKLOG);

    const ends = await pinGroupToTopicEnd(admin, pinnedGroup, topic.name);
    expect(Object.keys(ends).sort()).toEqual(["0", "1", "2"]);
    expect(Object.values(ends).reduce((sum, high) => sum + Number(high), 0)).toBe(BACKLOG);

    const after = await produce("after", AFTER);
    const pinned = await startReader(pinnedGroup);
    const control = await startReader(controlGroup);

    await pinned.waitUntilSeen(after);
    await control.waitUntilSeen([...backlog, ...after]);

    // Control: el mismo tópico y el mismo consumer, sin anclar, sí lee el backlog (la precondición era real).
    expect(control.seen.slice().sort()).toEqual([...backlog, ...after].sort());
    // Anclado: dentro de una partición el orden es el de producción, así que si leyera backlog llegaría antes que `after`.
    expect(pinned.seen.slice().sort()).toEqual(after.slice().sort());
  });
});
