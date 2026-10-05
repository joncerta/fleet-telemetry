import { Kafka, logLevel, type ConsumerConfig } from "kafkajs";
import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../logger/logger.js";
import { createConsumer, type FleetConsumerOptions } from "./admin-consumer.js";
import { kafkaLogCreator } from "./client.js";

describe("createConsumer", () => {
  // `new Kafka` no abre conexiones hasta `connect()`, así que no toca la red.
  function capture(options: FleetConsumerOptions): ConsumerConfig {
    const kafka = new Kafka({ brokers: ["127.0.0.1:1"], logLevel: logLevel.NOTHING });
    const spy = vi.spyOn(kafka, "consumer");
    createConsumer(kafka, options);
    const config = spy.mock.calls[0]?.[0];
    if (!config) throw new Error("no se creó el consumer");
    return config;
  }

  it("aplica valores por defecto sanos y desactiva la autocreación de tópicos", () => {
    const config = capture({ groupId: "processor" });

    expect(config).toMatchObject({
      groupId: "processor",
      sessionTimeout: 30_000,
      heartbeatInterval: 3_000,
      allowAutoTopicCreation: false,
      readUncommitted: false,
    });
  });

  it("deja ajustar timeouts pero no reactivar la autocreación de tópicos", () => {
    const sneaky = { groupId: "g", sessionTimeout: 10_000, allowAutoTopicCreation: true };

    const config = capture(sneaky);

    expect(config.sessionTimeout).toBe(10_000);
    expect(config.allowAutoTopicCreation).toBe(false);
  });
});

describe("kafkaLogCreator", () => {
  it("reenvía los logs de kafkajs al logger estructurado con su nivel", () => {
    const lines: string[] = [];
    const logger = createLogger({ service: "t", level: "debug", destination: { write: (l) => void lines.push(l) } });
    const log = kafkaLogCreator(logger)();

    log({
      namespace: "Producer",
      level: logLevel.WARN,
      label: "WARN",
      log: { timestamp: "2026-10-06T00:00:00.000Z", message: "reintentando", broker: "127.0.0.1:19092" },
    });

    const [entry] = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(entry).toMatchObject({
      level: "warn",
      msg: "reintentando",
      kafka: { namespace: "Producer", broker: "127.0.0.1:19092" },
    });
  });
});
