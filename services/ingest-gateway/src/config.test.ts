import { describe, expect, it } from "vitest";
import { loadGatewayConfig } from "./config.js";

const valid = {
  DATABASE_URL: "postgres://fleet_app:pw@127.0.0.1:5432/fleet",
  KAFKA_BROKERS: "127.0.0.1:19092",
};

describe("loadGatewayConfig: ingesta de telemetría", () => {
  it("aplica los valores por defecto documentados en .env.example", () => {
    const config = loadGatewayConfig(valid);

    expect(config).toMatchObject({
      INGEST_GATEWAY_RATE_LIMIT_MAX: 6_000,
      INGEST_GATEWAY_RATE_LIMIT_WINDOW_MS: 60_000,
      INGEST_GATEWAY_AUTH_FAILURE_LIMIT_MAX: 20,
      INGEST_GATEWAY_AUTH_FAILURE_LIMIT_WINDOW_MS: 60_000,
      INGEST_GATEWAY_TRUSTED_PROXY_HOPS: 0,
      INGEST_GATEWAY_MAX_AGE_MS: 604_800_000,
      INGEST_GATEWAY_MAX_POINT_BYTES: 8_192,
      INGEST_GATEWAY_MAX_IN_FLIGHT_PUBLICATIONS: 256,
      INGEST_GATEWAY_MAX_IN_FLIGHT_AUTH_LOOKUPS: 8,
      INGEST_GATEWAY_DEVICE_RATE_LIMIT_MAX: 60,
      INGEST_GATEWAY_DEVICE_RATE_LIMIT_WINDOW_MS: 60_000,
      INGEST_GATEWAY_TOKEN_CACHE_TTL_MS: 30_000,
      INGEST_GATEWAY_TOKEN_CACHE_NEGATIVE_TTL_MS: 5_000,
      INGEST_GATEWAY_TOKEN_CACHE_MAX_ENTRIES: 10_000,
      INGEST_GATEWAY_FUTURE_TOLERANCE_MS: 300_000,
      INGEST_GATEWAY_PUBLISH_TIMEOUT_MS: 8_000,
      INGEST_GATEWAY_KAFKA_RETRIES: 3,
    });
  });

  it("el TTL negativo por defecto es menor que el positivo", () => {
    const config = loadGatewayConfig(valid);

    expect(config.INGEST_GATEWAY_TOKEN_CACHE_NEGATIVE_TTL_MS).toBeLessThan(config.INGEST_GATEWAY_TOKEN_CACHE_TTL_MS);
  });

  it("convierte los valores del entorno a número", () => {
    const config = loadGatewayConfig({ ...valid, INGEST_GATEWAY_TOKEN_CACHE_TTL_MS: "10000", INGEST_GATEWAY_KAFKA_RETRIES: "5" });

    expect(config.INGEST_GATEWAY_TOKEN_CACHE_TTL_MS).toBe(10_000);
    expect(config.INGEST_GATEWAY_KAFKA_RETRIES).toBe(5);
  });

  it("los TTL admiten 0 (caché desactivada)", () => {
    const config = loadGatewayConfig({ ...valid, INGEST_GATEWAY_TOKEN_CACHE_TTL_MS: "0", INGEST_GATEWAY_TOKEN_CACHE_NEGATIVE_TTL_MS: "0" });

    expect(config.INGEST_GATEWAY_TOKEN_CACHE_TTL_MS).toBe(0);
  });

  it("INGEST_GATEWAY_MAX_AGE_MS acepta de 1 hora a 90 días (la retención), ambos extremos incluidos", () => {
    expect(loadGatewayConfig({ ...valid, INGEST_GATEWAY_MAX_AGE_MS: "3600000" }).INGEST_GATEWAY_MAX_AGE_MS).toBe(3_600_000);
    expect(loadGatewayConfig({ ...valid, INGEST_GATEWAY_MAX_AGE_MS: String(90 * 86_400_000) }).INGEST_GATEWAY_MAX_AGE_MS).toBe(90 * 86_400_000);
  });

  it("INGEST_GATEWAY_TRUSTED_PROXY_HOPS acepta de 0 a 5", () => {
    expect(loadGatewayConfig({ ...valid, INGEST_GATEWAY_TRUSTED_PROXY_HOPS: "0" }).INGEST_GATEWAY_TRUSTED_PROXY_HOPS).toBe(0);
    expect(loadGatewayConfig({ ...valid, INGEST_GATEWAY_TRUSTED_PROXY_HOPS: "5" }).INGEST_GATEWAY_TRUSTED_PROXY_HOPS).toBe(5);
  });

  it.each([
    ["INGEST_GATEWAY_MAX_AGE_MS", "3599999"],
    ["INGEST_GATEWAY_MAX_AGE_MS", String(90 * 86_400_000 + 1)],
    ["INGEST_GATEWAY_MAX_AGE_MS", "siete dias"],
    ["INGEST_GATEWAY_TRUSTED_PROXY_HOPS", "-1"],
    ["INGEST_GATEWAY_TRUSTED_PROXY_HOPS", "6"],
    ["INGEST_GATEWAY_TRUSTED_PROXY_HOPS", "1.5"],
    ["INGEST_GATEWAY_TRUSTED_PROXY_HOPS", "true"],
    ["INGEST_GATEWAY_AUTH_FAILURE_LIMIT_MAX", "0"],
    ["INGEST_GATEWAY_AUTH_FAILURE_LIMIT_WINDOW_MS", "999"],
    ["INGEST_GATEWAY_MAX_POINT_BYTES", "511"],
    ["INGEST_GATEWAY_MAX_POINT_BYTES", "65537"],
    ["INGEST_GATEWAY_MAX_IN_FLIGHT_PUBLICATIONS", "0"],
    ["INGEST_GATEWAY_MAX_IN_FLIGHT_PUBLICATIONS", "10001"],
    ["INGEST_GATEWAY_MAX_IN_FLIGHT_AUTH_LOOKUPS", "0"],
    ["INGEST_GATEWAY_MAX_IN_FLIGHT_AUTH_LOOKUPS", "101"],
  ])("rechaza %s=%s nombrando la variable", (name, value) => {
    expect(() => loadGatewayConfig({ ...valid, [name]: value })).toThrow(new RegExp(name));
  });

  it.each([
    ["INGEST_GATEWAY_DEVICE_RATE_LIMIT_MAX", "0"],
    ["INGEST_GATEWAY_DEVICE_RATE_LIMIT_WINDOW_MS", "999"],
    ["INGEST_GATEWAY_TOKEN_CACHE_TTL_MS", "-1"],
    ["INGEST_GATEWAY_TOKEN_CACHE_TTL_MS", "300001"],
    ["INGEST_GATEWAY_TOKEN_CACHE_NEGATIVE_TTL_MS", "300001"],
    ["INGEST_GATEWAY_TOKEN_CACHE_MAX_ENTRIES", "0"],
    ["INGEST_GATEWAY_FUTURE_TOLERANCE_MS", "-1"],
    ["INGEST_GATEWAY_FUTURE_TOLERANCE_MS", "3600001"],
    ["INGEST_GATEWAY_PUBLISH_TIMEOUT_MS", "499"],
    ["INGEST_GATEWAY_PUBLISH_TIMEOUT_MS", "60001"],
    ["INGEST_GATEWAY_KAFKA_RETRIES", "0"],
    ["INGEST_GATEWAY_KAFKA_RETRIES", "11"],
    ["INGEST_GATEWAY_KAFKA_RETRIES", "tres"],
  ])("rechaza %s=%s nombrando la variable", (name, value) => {
    expect(() => loadGatewayConfig({ ...valid, [name]: value })).toThrow(new RegExp(name));
  });
});
