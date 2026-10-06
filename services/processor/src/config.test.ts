import { ConfigError } from "@fleet/platform";
import { describe, expect, it } from "vitest";
import { loadProcessorConfig } from "./config.js";

const valid = {
  DATABASE_URL: "postgres://fleet_app:pw@127.0.0.1:5432/fleet",
  KAFKA_BROKERS: "127.0.0.1:19092",
};

describe("loadProcessorConfig", () => {
  it("aplica los valores por defecto: grupo processor, nivel info y 15 s de apagado", () => {
    const config = loadProcessorConfig(valid);

    expect(config.PROCESSOR_CONSUMER_GROUP).toBe("processor");
    expect(config.LOG_LEVEL).toBe("info");
    expect(config.SHUTDOWN_TIMEOUT_MS).toBe(15_000);
    expect(config.KAFKA_BROKERS).toEqual(["127.0.0.1:19092"]);
  });

  it("los reintentos, el tramo y el timeout de la DLQ tienen valores por defecto", () => {
    const config = loadProcessorConfig(valid);

    expect(config).toMatchObject({
      PROCESSOR_MAX_ATTEMPTS: 5,
      PROCESSOR_RETRY_INITIAL_DELAY_MS: 200,
      PROCESSOR_RETRY_MAX_DELAY_MS: 5_000,
      PROCESSOR_INSERT_CHUNK_SIZE: 500,
      PROCESSOR_DLQ_PUBLISH_TIMEOUT_MS: 8_000,
    });
  });

  it("los reintentos, el tramo y el timeout de la DLQ son configurables", () => {
    const config = loadProcessorConfig({
      ...valid,
      PROCESSOR_MAX_ATTEMPTS: "3",
      PROCESSOR_RETRY_INITIAL_DELAY_MS: "50",
      PROCESSOR_RETRY_MAX_DELAY_MS: "50",
      PROCESSOR_INSERT_CHUNK_SIZE: "100",
      PROCESSOR_DLQ_PUBLISH_TIMEOUT_MS: "1000",
    });

    expect(config).toMatchObject({
      PROCESSOR_MAX_ATTEMPTS: 3,
      PROCESSOR_RETRY_INITIAL_DELAY_MS: 50,
      PROCESSOR_RETRY_MAX_DELAY_MS: 50,
      PROCESSOR_INSERT_CHUNK_SIZE: 100,
      PROCESSOR_DLQ_PUBLISH_TIMEOUT_MS: 1_000,
    });
  });

  it.each([
    ["PROCESSOR_MAX_ATTEMPTS", "0"],
    ["PROCESSOR_MAX_ATTEMPTS", "21"],
    ["PROCESSOR_MAX_ATTEMPTS", "2.5"],
    ["PROCESSOR_RETRY_INITIAL_DELAY_MS", "9"],
    ["PROCESSOR_RETRY_MAX_DELAY_MS", "300001"],
    ["PROCESSOR_INSERT_CHUNK_SIZE", "0"],
    ["PROCESSOR_INSERT_CHUNK_SIZE", "1001"],
    ["PROCESSOR_DLQ_PUBLISH_TIMEOUT_MS", "499"],
    ["PROCESSOR_DLQ_PUBLISH_TIMEOUT_MS", "abc"],
  ])("rechaza %s=%s", (name, value) => {
    expect(() => loadProcessorConfig({ ...valid, [name]: value })).toThrow(new RegExp(name));
  });

  it("acepta el tramo máximo (1000)", () => {
    expect(loadProcessorConfig({ ...valid, PROCESSOR_INSERT_CHUNK_SIZE: "1000" }).PROCESSOR_INSERT_CHUNK_SIZE).toBe(1_000);
  });

  it("rechaza un tope de espera menor que la espera inicial, nombrando la variable", () => {
    expect(() => loadProcessorConfig({ ...valid, PROCESSOR_RETRY_INITIAL_DELAY_MS: "1000", PROCESSOR_RETRY_MAX_DELAY_MS: "500" })).toThrow(
      /PROCESSOR_RETRY_MAX_DELAY_MS/,
    );
  });

  it("el grupo es configurable (el e2e usa uno propio)", () => {
    expect(loadProcessorConfig({ ...valid, PROCESSOR_CONSUMER_GROUP: "processor-e2e-ab12cd34" }).PROCESSOR_CONSUMER_GROUP).toBe(
      "processor-e2e-ab12cd34",
    );
  });

  it.each(["con espacios", "salto\nde linea", "", "a".repeat(129), "grupo/con/barras"])("rechaza el grupo %j", (group) => {
    expect(() => loadProcessorConfig({ ...valid, PROCESSOR_CONSUMER_GROUP: group })).toThrow(/PROCESSOR_CONSUMER_GROUP/);
  });

  it("falla rápido nombrando todas las variables que faltan, sin valores", () => {
    const error = (() => {
      try {
        loadProcessorConfig({ DATABASE_URL: "postgres://fleet_app:secreto@127.0.0.1:5432/fleet" });
      } catch (e) {
        return e;
      }
    })();

    expect(error).toBeInstanceOf(ConfigError);
    expect(error).toHaveProperty("variables", ["KAFKA_BROKERS"]);
    expect(error).toHaveProperty("message", expect.not.stringContaining("secreto") as string);
  });
});
