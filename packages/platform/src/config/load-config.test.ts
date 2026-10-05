import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ConfigError, loadConfig } from "./load-config.js";
import { databaseAdminConfig, kafkaConfig, logConfig, migrationConfig } from "./fragments.js";

const schema = z.object({ ...databaseAdminConfig.shape, ...kafkaConfig.shape, ...logConfig.shape });

const validEnv = {
  DATABASE_ADMIN_URL: "postgres://fleet:pw@127.0.0.1:5432/fleet",
  FLEET_APP_PASSWORD: "app-pw",
  FLEET_RO_PASSWORD: "ro-pw",
  KAFKA_BROKERS: "127.0.0.1:19092, broker-2:9092",
  UNRELATED: "se ignora",
};

function catchConfigError(env: Record<string, string | undefined>): ConfigError {
  try {
    loadConfig(schema, env);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error("loadConfig debía fallar");
}

describe("loadConfig", () => {
  it("parsea, aplica defaults, transforma la lista de brokers y descarta variables ajenas", () => {
    const config = loadConfig(schema, validEnv);

    expect(config.KAFKA_BROKERS).toEqual(["127.0.0.1:19092", "broker-2:9092"]);
    expect(config.LOG_LEVEL).toBe("info");
    expect(config).not.toHaveProperty("UNRELATED");
  });

  it("falla nombrando cada variable faltante o inválida, todas a la vez", () => {
    const error = catchConfigError({ ...validEnv, DATABASE_ADMIN_URL: undefined, KAFKA_BROKERS: "sin-puerto", LOG_LEVEL: "" });

    expect(error.variables).toEqual(["DATABASE_ADMIN_URL", "KAFKA_BROKERS", "LOG_LEVEL"]);
    expect(error.message).toContain("DATABASE_ADMIN_URL: falta");
    expect(error.message).toContain("KAFKA_BROKERS: valor inválido");
    expect(error.message).toContain("LOG_LEVEL: está vacía");
    expect(error.message).toContain(".env.example");
  });

  it("no filtra el valor de ninguna variable en el mensaje ni en las propiedades del error", () => {
    const secrets = ["s3cr3t-url-value", "s3cr3t-password", "s3cr3t-level", "s3cr3t-broker"];
    const error = catchConfigError({
      DATABASE_ADMIN_URL: `no-es-url-${secrets[0]}`,
      FLEET_APP_PASSWORD: "ok",
      FLEET_RO_PASSWORD: "ok",
      KAFKA_BROKERS: `${secrets[3]}`,
      LOG_LEVEL: `${secrets[2]}`,
    });

    const serialized = `${error.message}\n${error.stack ?? ""}\n${JSON.stringify(error)}\n${String(error.cause)}`;
    for (const secret of secrets) expect(serialized).not.toContain(secret);
    expect(error.variables).toEqual(["DATABASE_ADMIN_URL", "KAFKA_BROKERS", "LOG_LEVEL"]);
    expect(error.cause).toBeUndefined();
  });

  it("trata una variable vacía como inválida, no como faltante", () => {
    const error = catchConfigError({ ...validEnv, FLEET_RO_PASSWORD: "" });

    expect(error.message).toContain("FLEET_RO_PASSWORD: está vacía");
  });
});

describe("migrationConfig (DB_MIGRATE_LOCK_TIMEOUT_MS)", () => {
  const migrationSchema = z.object({ ...migrationConfig.shape });

  it("por defecto son 8 s, dentro del rango de 5 a 10 s", () => {
    expect(loadConfig(migrationSchema, {}).DB_MIGRATE_LOCK_TIMEOUT_MS).toBe(8_000);
  });

  it("acepta un valor entero dentro del rango", () => {
    expect(loadConfig(migrationSchema, { DB_MIGRATE_LOCK_TIMEOUT_MS: "5000" }).DB_MIGRATE_LOCK_TIMEOUT_MS).toBe(5_000);
  });

  it.each(["0", "999", "60001", "abc", "1.5", "-5"])("rechaza %s y nombra la variable", (value) => {
    expect(() => loadConfig(migrationSchema, { DB_MIGRATE_LOCK_TIMEOUT_MS: value })).toThrow(/DB_MIGRATE_LOCK_TIMEOUT_MS/);
  });
});
