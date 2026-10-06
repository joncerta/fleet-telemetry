import { describe, expect, it } from "vitest";
import { loadFleetApiConfig, MAX_SSE_HEARTBEAT_MS } from "./config.js";

const valid = {
  DATABASE_URL: "postgres://fleet_app:pw@127.0.0.1:5432/fleet",
  KAFKA_BROKERS: "127.0.0.1:19092",
  SESSION_SECRET: "s".repeat(32),
};

describe("loadFleetApiConfig", () => {
  it("aplica los valores por defecto documentados en .env.example", () => {
    expect(loadFleetApiConfig(valid)).toMatchObject({
      FLEET_API_HOST: "127.0.0.1",
      FLEET_API_PORT: 4002,
      SESSION_TTL_HOURS: 12,
      FLEET_API_CORS_ORIGINS: ["http://localhost:3000"],
      FLEET_API_COOKIE_SECURE: false,
      SSE_HEARTBEAT_MS: 15_000,
      SSE_MAX_STREAMS_PER_USER: 5,
      SSE_MAX_PENDING_BYTES: 4_194_304,
      SSE_RETRY_MS: 3_000,
      SSE_RETRY_JITTER_MS: 5_000,
      SSE_RATE_LIMIT_MAX: 30,
      SSE_RATE_LIMIT_WINDOW_MS: 60_000,
      SSE_SNAPSHOT_POOL_MAX: 3,
      FLEET_API_TRUSTED_PROXY_HOPS: 0,
      FLEET_API_LOGIN_FAILURE_LIMIT_MAX: 10,
      FLEET_API_PAIR_FAILURE_LIMIT_MAX: 10,
      FLEET_API_PAIRING_CODE_TTL_MINUTES: 10,
    });
  });

  describe("SESSION_SECRET", () => {
    it("es obligatoria y falla al arrancar si falta o tiene menos de 32 bytes", () => {
      const { SESSION_SECRET: _omitted, ...withoutSecret } = valid;

      expect(() => loadFleetApiConfig(withoutSecret)).toThrow(/SESSION_SECRET/);
      expect(() => loadFleetApiConfig({ ...valid, SESSION_SECRET: "x".repeat(31) })).toThrow(/SESSION_SECRET/);
      expect(loadFleetApiConfig({ ...valid, SESSION_SECRET: "x".repeat(32) }).SESSION_SECRET).toHaveLength(32);
    });

    it("el error no incluye el valor del secreto", () => {
      const short = "secreto-corto-pero-secreto";

      expect(() => loadFleetApiConfig({ ...valid, SESSION_SECRET: short })).not.toThrow(new RegExp(short));
      expect(() => loadFleetApiConfig({ ...valid, SESSION_SECRET: short })).toThrow(/SESSION_SECRET/);
    });
  });

  describe("SSE_HEARTBEAT_MS", () => {
    it("el máximo es 30000 (el idle timeout del ALB es 120 s y exige al menos 2 latidos de margen)", () => {
      expect(MAX_SSE_HEARTBEAT_MS).toBe(30_000);
      expect(MAX_SSE_HEARTBEAT_MS * 2).toBeLessThanOrEqual(120_000);
      expect(loadFleetApiConfig({ ...valid, SSE_HEARTBEAT_MS: "30000" }).SSE_HEARTBEAT_MS).toBe(30_000);
    });

    it.each(["30001", "120000", "999", "0", "-1", "rapido", "15000.5"])("rechaza %s", (value) => {
      expect(() => loadFleetApiConfig({ ...valid, SSE_HEARTBEAT_MS: value })).toThrow(/SSE_HEARTBEAT_MS/);
    });
  });

  describe("FLEET_API_INSTANCE_ID", () => {
    it("por defecto es un uuid distinto en cada carga (un grupo propio por proceso)", () => {
      const first = loadFleetApiConfig(valid).FLEET_API_INSTANCE_ID;
      const second = loadFleetApiConfig(valid).FLEET_API_INSTANCE_ID;

      expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(second).not.toBe(first);
    });

    it("acepta un valor explícito (el nombre del pod, por ejemplo)", () => {
      expect(loadFleetApiConfig({ ...valid, FLEET_API_INSTANCE_ID: "fleet-api-0.prod" }).FLEET_API_INSTANCE_ID).toBe("fleet-api-0.prod");
    });

    it.each(["", "con espacio", "a/b", "a".repeat(65), "ñandú"])("rechaza %j (forma el nombre de un grupo de Kafka)", (value) => {
      expect(() => loadFleetApiConfig({ ...valid, FLEET_API_INSTANCE_ID: value })).toThrow(/FLEET_API_INSTANCE_ID/);
    });
  });

  describe("FLEET_API_CORS_ORIGINS", () => {
    it("acepta una lista explícita separada por comas, recortando espacios", () => {
      const config = loadFleetApiConfig({ ...valid, FLEET_API_CORS_ORIGINS: "http://localhost:3000, https://flota.example.com" });

      expect(config.FLEET_API_CORS_ORIGINS).toEqual(["http://localhost:3000", "https://flota.example.com"]);
    });

    it.each(["*", "http://localhost:3000/", "http://localhost:3000/ruta", "localhost:3000", "ftp://x.test", "http://*.x.test", "", " , ", "https://x.test, *"])(
      "rechaza %j (sin comodín, sin ruta, solo origen http o https)",
      (value) => {
        expect(() => loadFleetApiConfig({ ...valid, FLEET_API_CORS_ORIGINS: value })).toThrow(/FLEET_API_CORS_ORIGINS/);
      },
    );
  });

  describe("FLEET_API_COOKIE_SECURE", () => {
    it("lee true y false como texto (no como el truthy de un string)", () => {
      expect(loadFleetApiConfig({ ...valid, FLEET_API_COOKIE_SECURE: "true" }).FLEET_API_COOKIE_SECURE).toBe(true);
      expect(loadFleetApiConfig({ ...valid, FLEET_API_COOKIE_SECURE: "false" }).FLEET_API_COOKIE_SECURE).toBe(false);
    });

    it.each(["1", "yes", "TRUE", ""])("rechaza %j", (value) => {
      expect(() => loadFleetApiConfig({ ...valid, FLEET_API_COOKIE_SECURE: value })).toThrow(/FLEET_API_COOKIE_SECURE/);
    });
  });

  it.each([
    ["SESSION_TTL_HOURS", "0"],
    ["SESSION_TTL_HOURS", "721"],
    ["FLEET_API_PORT", "0"],
    ["FLEET_API_PORT", "70000"],
    ["FLEET_API_TRUSTED_PROXY_HOPS", "6"],
    ["FLEET_API_LOGIN_FAILURE_LIMIT_MAX", "0"],
    ["FLEET_API_LOGIN_FAILURE_LIMIT_WINDOW_MS", "999"],
    ["FLEET_API_PAIR_FAILURE_LIMIT_MAX", "0"],
    ["FLEET_API_PAIRING_CODE_TTL_MINUTES", "0"],
    ["FLEET_API_PAIRING_CODE_TTL_MINUTES", "61"],
    ["SSE_MAX_STREAMS_PER_USER", "0"],
    ["SSE_MAX_STREAMS_PER_USER", "101"],
    ["SSE_MAX_PENDING_BYTES", "65535"],
    ["SSE_MAX_PENDING_BYTES", "67108865"],
    ["SSE_RETRY_MS", "999"],
    ["SSE_RETRY_JITTER_MS", "-1"],
    ["SSE_RATE_LIMIT_MAX", "0"],
    ["SSE_RATE_LIMIT_WINDOW_MS", "999"],
    ["SSE_SNAPSHOT_POOL_MAX", "0"],
    ["SSE_SNAPSHOT_POOL_MAX", "21"],
  ])("rechaza %s=%s nombrando la variable", (name, value) => {
    expect(() => loadFleetApiConfig({ ...valid, [name]: value })).toThrow(new RegExp(name));
  });
});
