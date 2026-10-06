import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_MODEL, loadAgentConfig } from "./config.js";

const valid = { SESSION_SECRET: "s".repeat(32), ANTHROPIC_API_KEY: "sk-ant-test" };

describe("loadAgentConfig", () => {
  it("aplica los valores por defecto documentados en .env.example", () => {
    expect(loadAgentConfig(valid)).toMatchObject({
      AGENT_HOST: "127.0.0.1",
      AGENT_PORT: 4003,
      FLEET_API_URL: "http://127.0.0.1:4002",
      AGENT_CORS_ORIGINS: ["http://localhost:3000"],
      AGENT_MODEL_PROVIDER: "anthropic",
      AGENT_MODEL: "claude-sonnet-5-5",
      AGENT_MAX_ITERATIONS: 6,
      AGENT_TIMEOUT_MS: 60_000,
      AGENT_USER_RATE_LIMIT_MAX: 20,
      AGENT_FLEET_API_TIMEOUT_MS: 3_000,
      AGENT_BREAKER_ERROR_THRESHOLD_PERCENTAGE: 50,
      AGENT_BREAKER_VOLUME_THRESHOLD: 5,
      AGENT_BREAKER_RESET_TIMEOUT_MS: 15_000,
    });
    expect(DEFAULT_AGENT_MODEL).toBe("claude-sonnet-5-5");
  });

  it("SESSION_SECRET es obligatoria, de al menos 32 bytes, y el error no la revela", () => {
    const short = "secreto-corto-pero-secreto";

    expect(() => loadAgentConfig({ ANTHROPIC_API_KEY: "k" })).toThrow(/SESSION_SECRET/);
    expect(() => loadAgentConfig({ ...valid, SESSION_SECRET: short })).toThrow(/SESSION_SECRET/);
    expect(() => loadAgentConfig({ ...valid, SESSION_SECRET: short })).not.toThrow(new RegExp(short));
  });

  describe("ANTHROPIC_API_KEY", () => {
    it("es obligatoria con el proveedor anthropic", () => {
      expect(() => loadAgentConfig({ SESSION_SECRET: valid.SESSION_SECRET })).toThrow(/ANTHROPIC_API_KEY/);
      expect(() => loadAgentConfig({ ...valid, ANTHROPIC_API_KEY: "" })).toThrow(/ANTHROPIC_API_KEY/);
    });

    it("no se exige con el proveedor con guion (el CI no necesita API key)", () => {
      const config = loadAgentConfig({ SESSION_SECRET: valid.SESSION_SECRET, AGENT_MODEL_PROVIDER: "scripted" });

      expect(config.AGENT_MODEL_PROVIDER).toBe("scripted");
      expect(config.ANTHROPIC_API_KEY).toBeUndefined();
    });

    it("con el proveedor con guion una API key vacía (como la deja el .env.example) no falla", () => {
      expect(loadAgentConfig({ SESSION_SECRET: valid.SESSION_SECRET, AGENT_MODEL_PROVIDER: "scripted", ANTHROPIC_API_KEY: "" }).AGENT_MODEL_PROVIDER).toBe("scripted");
    });

    it("rechaza un proveedor desconocido", () => {
      expect(() => loadAgentConfig({ ...valid, AGENT_MODEL_PROVIDER: "openai" })).toThrow(/AGENT_MODEL_PROVIDER/);
    });
  });

  describe("FLEET_API_URL", () => {
    it("acepta http y https y rechaza otros esquemas, texto que no es URL y credenciales incrustadas", () => {
      expect(loadAgentConfig({ ...valid, FLEET_API_URL: "https://fleet-api.internal:4002" }).FLEET_API_URL).toBe("https://fleet-api.internal:4002");
      for (const value of ["ftp://x", "no-es-url", "http://usuario:clave@host:4002"]) {
        expect(() => loadAgentConfig({ ...valid, FLEET_API_URL: value })).toThrow(/FLEET_API_URL/);
      }
    });
  });

  describe("AGENT_CORS_ORIGINS", () => {
    it("acepta una lista explícita y rechaza comodines, rutas y la lista vacía", () => {
      expect(loadAgentConfig({ ...valid, AGENT_CORS_ORIGINS: "http://localhost:3000, https://flota.example.com" }).AGENT_CORS_ORIGINS).toEqual([
        "http://localhost:3000",
        "https://flota.example.com",
      ]);
      for (const value of ["*", "http://localhost:3000/ruta", "https://*.example.com", " , "]) {
        expect(() => loadAgentConfig({ ...valid, AGENT_CORS_ORIGINS: value })).toThrow(/AGENT_CORS_ORIGINS/);
      }
    });
  });

  it.each([
    ["AGENT_PORT", "0"],
    ["AGENT_MAX_ITERATIONS", "0"],
    ["AGENT_TIMEOUT_MS", "10"],
    ["AGENT_BREAKER_ERROR_THRESHOLD_PERCENTAGE", "101"],
    ["AGENT_BREAKER_VOLUME_THRESHOLD", "0"],
    ["AGENT_FLEET_API_TIMEOUT_MS", "rapido"],
  ])("rechaza %s=%s", (name, value) => {
    expect(() => loadAgentConfig({ ...valid, [name]: value })).toThrow(new RegExp(name));
  });
});
