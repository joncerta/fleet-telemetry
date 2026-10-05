import { Partitioners, type ProducerConfig, type ProducerRecord, type RecordMetadata } from "kafkajs";
import { describe, expect, it, vi } from "vitest";
import { CorrelationIdError, withCorrelationId } from "./headers.js";
import { javaPartition, KAFKA_MURMUR2_VECTORS } from "./murmur2-vectors.fixture.js";
import { ACKS_ALL, createProducer, FLEET_PARTITIONER, type FleetSendRecord } from "./producer.js";

const headers = withCorrelationId(undefined, "c-1");

// Sin red: se sustituye `Kafka` por un doble que captura la configuración y los envíos.
function setup() {
  const sent: ProducerRecord[] = [];
  const batches: unknown[] = [];
  const configs: ProducerConfig[] = [];
  const metadata: RecordMetadata[] = [];
  const kafka = {
    producer: (config: ProducerConfig) => {
      configs.push(config);
      return {
        connect: vi.fn(() => Promise.resolve()),
        disconnect: vi.fn(() => Promise.resolve()),
        send: vi.fn((record: ProducerRecord) => {
          sent.push(record);
          return Promise.resolve(metadata);
        }),
        sendBatch: vi.fn((batch: unknown) => {
          batches.push(batch);
          return Promise.resolve(metadata);
        }),
      };
    },
  };
  return { kafka, sent, batches, configs };
}

describe("createProducer", () => {
  it("crea un productor idempotente, sin autocreación de tópicos y con particionador explícito", () => {
    const { kafka, configs } = setup();

    createProducer(kafka);

    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({
      idempotent: true,
      maxInFlightRequests: 1,
      allowAutoTopicCreation: false,
    });
    expect(configs[0]?.createPartitioner).toBe(Partitioners.DefaultPartitioner);
    expect(FLEET_PARTITIONER).not.toBe(Partitioners.LegacyPartitioner);
  });

  it("pasa retry y metadataMaxAge al productor", () => {
    const { kafka, configs } = setup();

    createProducer(kafka, { retry: { retries: 3 }, metadataMaxAge: 1000 });

    expect(configs[0]).toMatchObject({ retry: { retries: 3 }, metadataMaxAge: 1000, idempotent: true });
  });

  it("no permite desactivar la idempotencia ni lo demás aunque se cuele en runtime", () => {
    const { kafka, configs } = setup();
    const sneaky = { idempotent: false, maxInFlightRequests: 5, allowAutoTopicCreation: true, retry: { retries: 3 } };

    createProducer(kafka, sneaky);

    expect(configs[0]).toMatchObject({ idempotent: true, maxInFlightRequests: 1, allowAutoTopicCreation: false });
  });

  it("fuerza acks=-1 en send aunque el llamador no lo pase", async () => {
    const { kafka, sent } = setup();
    const producer = createProducer(kafka);

    await producer.send({ topic: "telemetry.raw", messages: [{ key: "veh-1", value: "{}", headers }] });

    expect(sent[0]?.acks).toBe(ACKS_ALL);
    expect(ACKS_ALL).toBe(-1);
  });

  it("sobrescribe un acks distinto que se cuele en runtime, en send y en sendBatch", async () => {
    const { kafka, sent, batches } = setup();
    const producer = createProducer(kafka);
    const sneakyRecord = { topic: "telemetry.raw", messages: [{ key: "veh-1", value: "{}", headers }], acks: 0 };
    const sneakyBatch = { topicMessages: [{ topic: "telemetry.raw", messages: [{ key: "veh-1", value: "{}", headers }] }], acks: 1 };

    await producer.send(sneakyRecord);
    await producer.sendBatch(sneakyBatch);

    expect(sent[0]?.acks).toBe(-1);
    expect(batches[0]).toMatchObject({ acks: -1 });
  });

  it("conserva topic, mensajes, key y headers al enviar", async () => {
    const { kafka, sent } = setup();
    const producer = createProducer(kafka);
    const record: FleetSendRecord = {
      topic: "vehicle.state",
      messages: [{ key: "veh-9", value: "x", headers: { correlationId: "c-1", source: "gateway" } }],
    };

    await producer.send(record);

    expect(sent[0]).toMatchObject(record);
  });

  it("send rechaza un mensaje sin correlationId antes de llamar al productor", async () => {
    const { kafka, sent } = setup();
    const producer = createProducer(kafka);
    // El tipo ya lo impide; se simula a quien llega con datos sin pasar por el compilador.
    const withoutHeaders = { topic: "telemetry.raw", messages: [{ key: "veh-1", value: "{}" }] } as FleetSendRecord;

    await expect(producer.send(withoutHeaders)).rejects.toBeInstanceOf(CorrelationIdError);
    expect(sent).toEqual([]);
  });

  it("send rechaza un correlationId con formato inválido, aunque solo sea uno de varios mensajes", async () => {
    const { kafka, sent } = setup();
    const producer = createProducer(kafka);
    const bad = { correlationId: "con espacios" };

    await expect(
      producer.send({
        topic: "telemetry.raw",
        messages: [
          { key: "veh-1", value: "{}", headers },
          { key: "veh-2", value: "{}", headers: bad },
        ],
      }),
    ).rejects.toBeInstanceOf(CorrelationIdError);
    expect(sent).toEqual([]);
  });

  it("sendBatch también exige el correlationId en todos los tópicos", async () => {
    const { kafka, batches } = setup();
    const producer = createProducer(kafka);

    await expect(
      producer.sendBatch({
        topicMessages: [
          { topic: "a", messages: [{ key: "k", value: "x", headers }] },
          { topic: "b", messages: [{ key: "k", value: "x", headers: { correlationId: "" } }] },
        ],
      }),
    ).rejects.toBeInstanceOf(CorrelationIdError);
    expect(batches).toEqual([]);
  });
});

describe("FLEET_PARTITIONER (compatibilidad con el productor Java)", () => {
  // Vectores de Apache Kafka (UtilsTest.testMurmur2), ver murmur2-vectors.fixture.ts.
  const partitioner = FLEET_PARTITIONER();
  const metadata = (n: number) =>
    Array.from({ length: n }, (_, partitionId) => ({ partitionErrorCode: 0, partitionId, leader: 0, replicas: [0], isr: [0] }));

  it.each(KAFKA_MURMUR2_VECTORS.flatMap((vector) => [1, 3, 12, 50].map((n) => ({ ...vector, n }))))(
    "la key $key va a la partición Java con $n particiones",
    ({ key, hash, n }) => {
      const partition = partitioner({ topic: "t", partitionMetadata: metadata(n), message: { key, value: "x" } });

      expect(partition).toBe(javaPartition(hash, n));
    },
  );
});
