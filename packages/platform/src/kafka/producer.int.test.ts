import { randomUUID } from "node:crypto";
import type { Admin, Consumer, EachMessagePayload } from "kafkajs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integrationConfig as config } from "../testing/integration-support.js";
import { createTempTopic, type TempTopic } from "../testing/temp-topic.js";
import { createAdmin, createConsumer } from "./admin-consumer.js";
import { createKafka } from "./client.js";
import { getCorrelationId, withCorrelationId } from "./headers.js";
import { javaPartition, KAFKA_MURMUR2_VECTORS } from "./murmur2-vectors.fixture.js";
import { createProducer, type FleetProducer } from "./producer.js";

// Tópico temporal creado con el admin y borrado al final: nunca se usan los tópicos reales.
const kafka = createKafka({ brokers: config.KAFKA_BROKERS, clientId: "fleet-platform-it" });
const groupId = `fleet-it-group-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
let admin: Admin | undefined;
let topic: TempTopic | undefined;
let producer: FleetProducer | undefined;
let consumer: Consumer | undefined;

beforeAll(async () => {
  admin = createAdmin(kafka);
  await admin.connect();
  topic = await createTempTopic(admin, 3);
  producer = createProducer(kafka);
  await producer.connect();
}, 30_000);

afterAll(async () => {
  await producer?.disconnect();
  await consumer?.disconnect();
  // Limpieza: grupo y tópico temporales. Si el broker aún no libera el grupo, no debe romper el test.
  await admin?.deleteGroups([groupId]).catch(() => undefined);
  await topic?.drop();
  await admin?.disconnect();
});

function ready(): { producer: FleetProducer; topic: TempTopic } {
  if (!producer || !topic) throw new Error("El stack de prueba no se inicializó: falló beforeAll");
  return { producer, topic };
}

describe("productor de la fábrica contra Redpanda", () => {
  it("produce con key y header correlationId, y el consumer los recibe intactos", async () => {
    const { producer: p, topic: t } = ready();
    const groupConsumer = createConsumer(kafka, { groupId });
    consumer = groupConsumer;

    const received = new Promise<EachMessagePayload>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timeout esperando el mensaje en el tópico temporal")), 35_000);
      void (async () => {
        await groupConsumer.connect();
        await groupConsumer.subscribe({ topic: t.name, fromBeginning: true });
        await groupConsumer.run({
          eachMessage: (payload) => {
            clearTimeout(timer);
            resolve(payload);
            return Promise.resolve();
          },
        });
      })().catch((error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("falló el consumer"));
      });
    });

    const sent = await p.send({
      topic: t.name,
      messages: [{ key: "veh-it-1", value: JSON.stringify({ n: 1 }), headers: withCorrelationId(undefined, "corr-it-1") }],
    });

    const message = await received;
    expect(sent[0]?.errorCode).toBe(0);
    expect(message.topic).toBe(t.name);
    expect(message.message.key?.toString()).toBe("veh-it-1");
    expect(message.message.value?.toString()).toBe('{"n":1}');
    expect(getCorrelationId(message.message.headers)).toBe("corr-it-1");
    expect(message.partition).toBe(sent[0]?.partition);
  }, 45_000);

  it("asigna la partición que calcularía un productor Java (vectores murmur2 de Apache Kafka)", async () => {
    const { producer: p, topic: t } = ready();
    const partitions = 3; // las del tópico temporal de beforeAll

    const assigned: Record<string, number | undefined> = {};
    for (const { key } of KAFKA_MURMUR2_VECTORS) {
      const result = await p.send({ topic: t.name, messages: [{ key, value: "x", headers: withCorrelationId(undefined, "corr-it-2") }] });
      assigned[key] = result[0]?.partition;
    }

    expect(assigned).toEqual(Object.fromEntries(KAFKA_MURMUR2_VECTORS.map(({ key, hash }) => [key, javaPartition(hash, partitions)])));
    // Los vectores no caen todos en la misma partición: el test distingue un particionador de una constante.
    expect(new Set(Object.values(assigned)).size).toBeGreaterThan(1);
  });
});
