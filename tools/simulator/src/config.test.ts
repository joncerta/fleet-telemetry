import { loadConfig } from "@fleet/platform";
import { describe, expect, it } from "vitest";
import { simulatorConfigSchema } from "./config.js";

describe("simulatorConfigSchema", () => {
  it("sin variables usa los valores de la demo", () => {
    expect(loadConfig(simulatorConfigSchema, {})).toEqual({
      SIMULATOR_GATEWAY_URL: "http://127.0.0.1:4001",
      SIMULATOR_VEHICLES_PER_TENANT: 15,
      SIMULATOR_POINT_INTERVAL_MS: 5_000,
      SIMULATOR_BATCH_MIN_MS: 10_000,
      SIMULATOR_BATCH_MAX_MS: 15_000,
      SIMULATOR_SEED: 1,
      SIMULATOR_SILENT_AFTER_S: 60,
      SIMULATOR_STATS_INTERVAL_S: 30,
    });
  });

  it("lee las variables como números y la duración opcional", () => {
    const config = loadConfig(simulatorConfigSchema, {
      SIMULATOR_GATEWAY_URL: "http://127.0.0.1:4101",
      SIMULATOR_VEHICLES_PER_TENANT: "6",
      SIMULATOR_SEED: "42",
      SIMULATOR_DURATION_S: "120",
    });

    expect(config).toMatchObject({ SIMULATOR_GATEWAY_URL: "http://127.0.0.1:4101", SIMULATOR_VEHICLES_PER_TENANT: 6, SIMULATOR_SEED: 42, SIMULATOR_DURATION_S: 120 });
  });

  it.each([
    ["SIMULATOR_VEHICLES_PER_TENANT", "3"],
    ["SIMULATOR_VEHICLES_PER_TENANT", "16"],
    ["SIMULATOR_GATEWAY_URL", "ftp://127.0.0.1"],
    ["SIMULATOR_GATEWAY_URL", "no-es-url"],
    ["SIMULATOR_POINT_INTERVAL_MS", "10"],
    ["SIMULATOR_SEED", "-1"],
    ["SIMULATOR_DURATION_S", "0"],
  ])("rechaza %s=%s nombrando la variable y no su valor", (name, value) => {
    expect(() => loadConfig(simulatorConfigSchema, { [name]: value })).toThrow(name);
  });

  it("rechaza un lote máximo menor que el mínimo", () => {
    expect(() => loadConfig(simulatorConfigSchema, { SIMULATOR_BATCH_MIN_MS: "20000", SIMULATOR_BATCH_MAX_MS: "10000" })).toThrow("SIMULATOR_BATCH_MAX_MS");
  });
});
