import { describe, expect, it } from "vitest";
import { sessionSecretConfig } from "./fragments.js";
import { ConfigError, loadConfig, type Env } from "./load-config.js";

function configError(env: Env): ConfigError {
  try {
    loadConfig(sessionSecretConfig, env);
  } catch (caught) {
    if (caught instanceof ConfigError) return caught;
    throw caught;
  }
  throw new Error("la configuración debía fallar");
}

describe("sessionSecretConfig", () => {
  it("acepta un secreto de al menos 32 bytes", () => {
    expect(loadConfig(sessionSecretConfig, { SESSION_SECRET: "s".repeat(32) }).SESSION_SECRET).toBe("s".repeat(32));
  });

  it("falla al arrancar con un secreto de 31 bytes, ausente o vacío, nombrando la variable pero nunca su valor", () => {
    const short = "x".repeat(31);

    for (const env of [{ SESSION_SECRET: short }, {}, { SESSION_SECRET: "" }]) {
      const error = configError(env);

      expect(error.variables).toEqual(["SESSION_SECRET"]);
      expect(error.message).not.toContain(short);
    }
  });
});
