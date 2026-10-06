import { apiErrorSchema, healthResponseSchema, livenessResponseSchema, type HealthResponse } from "@fleet/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ALLOWED_ORIGIN, makeTestApp, type TestAppOptions } from "../../testing/test-app.js";
import { type FleetApiApp } from "./build-app.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let current: FleetApiApp | undefined;

afterEach(async () => {
  await current?.close();
  current = undefined;
});

/** App de prueba con rutas extra para los caminos de error. */
async function makeApp(options: TestAppOptions = {}) {
  const made = await makeTestApp({
    ...options,
    app: {
      ...options.app,
      registerRoutes: (instance) => {
        instance.post(
          "/probe",
          { schema: { body: z.object({ n: z.number() }), response: { 200: z.object({ ok: z.literal(true) }) } } },
          () => ({ ok: true as const }),
        );
        instance.get("/boom", () => {
          throw new Error("SELECT * FROM vehicle_state WHERE lat = 6.2518 AND lon = -75.5636: password authentication failed");
        });
        instance.get("/pg-error", () => {
          throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505", detail: "Key (code_hash)=(abc) already exists." });
        });
      },
    },
  });
  current = made.app;
  return made;
}

describe("GET /health", () => {
  it("responde 200 con los estados cuando todo responde, y cumple healthResponseSchema", async () => {
    const { app } = await makeApp();

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(healthResponseSchema.parse(response.json())).toEqual({ status: "ok", checks: { database: "up" } });
  });

  it("responde 503 con el mismo cuerpo cuando la base cae", async () => {
    const degraded: HealthResponse = { status: "degraded", checks: { database: "down" } };
    const { app } = await makeApp({ app: { checkHealth: () => Promise.resolve(degraded) } });

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(503);
    expect(healthResponseSchema.parse(response.json())).toEqual(degraded);
  });

  it("no cuenta para el rate limit", async () => {
    const { app } = await makeApp({ app: { rateLimit: { max: 1, timeWindowMs: 60_000 } } });

    for (let i = 0; i < 5; i++) expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });
});

describe("GET /health/live", () => {
  it("responde 200 { status: ok } aunque la base y Kafka caigan, sin consultar las dependencias", async () => {
    const checkHealth = vi.fn(() => Promise.reject(new Error("connection refused")));
    const { app } = await makeApp({ app: { checkHealth } });

    const response = await app.inject({ method: "GET", url: "/health/live" });

    expect(response.statusCode).toBe(200);
    expect(livenessResponseSchema.parse(response.json())).toEqual({ status: "ok" });
    expect(checkHealth).not.toHaveBeenCalled();
  });

  it("no cuenta para el rate limit", async () => {
    const { app } = await makeApp({ app: { rateLimit: { max: 1, timeWindowMs: 60_000 } } });

    for (let i = 0; i < 5; i++) expect((await app.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);
  });
});

describe("correlationId", () => {
  it("toma un x-correlation-id válido, lo devuelve y lo pone en cada línea del log de la petición", async () => {
    const { app, logged } = await makeApp();

    const response = await app.inject({ method: "GET", url: "/health", headers: { "x-correlation-id": "web-1:abc_2.3" } });

    expect(response.headers["x-correlation-id"]).toBe("web-1:abc_2.3");
    const requestLines = logged().filter((line) => line.correlationId !== undefined);
    expect(requestLines.length).toBeGreaterThanOrEqual(2);
    expect(requestLines.every((line) => line.correlationId === "web-1:abc_2.3")).toBe(true);
  });

  it.each([
    ["con espacios y salto de línea", "abc def\nghi"],
    ["con caracteres fuera del formato", "id/con/barras"],
    ["más largo que 128", "a".repeat(129)],
  ])("genera uno nuevo si el header viene %s", async (_label, value) => {
    const { app, raw } = await makeApp();

    const response = await app.inject({ method: "GET", url: "/health", headers: { "x-correlation-id": value } });

    expect(response.headers["x-correlation-id"]).toMatch(UUID);
    expect(raw()).not.toContain(value);
  });

  it("también lo llevan las respuestas de error", async () => {
    const { app } = await makeApp();

    const response = await app.inject({ method: "GET", url: "/no-existe", headers: { "x-correlation-id": "trace-9" } });

    expect(response.statusCode).toBe(404);
    expect(response.headers["x-correlation-id"]).toBe("trace-9");
  });
});

describe("logs de petición (privacidad)", () => {
  it("registran método, ruta y estado, pero ni la query, ni la IP, ni la cookie de sesión ni otros headers", async () => {
    const { app, raw } = await makeApp();

    await app.inject({
      method: "GET",
      url: "/health?lat=6.2518&lon=-75.5636",
      headers: { cookie: "fleet_session=v1.secreto.firma", "user-agent": "agente-secreto" },
      remoteAddress: "203.0.113.7",
    });

    const text = raw();
    expect(text).toContain('"url":"/health"');
    expect(text).toContain('"statusCode":200');
    for (const forbidden of ["6.2518", "-75.5636", "203.0.113.7", "fleet_session", "v1.secreto.firma", "agente-secreto"]) {
      expect(text).not.toContain(forbidden);
    }
  });
});

describe("cabeceras de seguridad", () => {
  it("toda respuesta, también las de error, lleva Cache-Control: no-store", async () => {
    const { app } = await makeApp();

    for (const url of ["/health", "/no-existe", "/boom"]) {
      expect((await app.inject({ method: "GET", url })).headers["cache-control"]).toBe("no-store");
    }
  });
});

describe("CORS con credenciales", () => {
  it("un origen configurado recibe su propio origen (no *) y Allow-Credentials", async () => {
    const { app } = await makeApp();

    const response = await app.inject({ method: "GET", url: "/health", headers: { origin: ALLOWED_ORIGIN } });

    expect(response.headers["access-control-allow-origin"]).toBe(ALLOWED_ORIGIN);
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
    expect(response.headers.vary).toMatch(/origin/i);
    expect(response.headers["access-control-expose-headers"]).toMatch(/x-correlation-id/i);
  });

  it("un origen que no está en la lista no recibe Access-Control-Allow-Origin", async () => {
    const { app } = await makeApp();

    for (const origin of ["http://evil.test", "http://localhost:3001", "https://localhost:3000", "null"]) {
      const response = await app.inject({ method: "GET", url: "/health", headers: { origin } });
      expect(response.headers["access-control-allow-origin"], origin).toBeUndefined();
    }
  });

  it("responde el preflight del origen permitido con los métodos y headers de la API", async () => {
    const { app } = await makeApp();

    const response = await app.inject({
      method: "OPTIONS",
      url: "/v1/devices/pairing-codes",
      headers: { origin: ALLOWED_ORIGIN, "access-control-request-method": "POST", "access-control-request-headers": "content-type,x-correlation-id" },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe(ALLOWED_ORIGIN);
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
    expect(response.headers["access-control-allow-methods"]).toMatch(/POST/);
  });

  it("el preflight de un origen no permitido no autoriza nada", async () => {
    const { app } = await makeApp();

    const response = await app.inject({
      method: "OPTIONS",
      url: "/v1/devices/pairing-codes",
      headers: { origin: "http://evil.test", "access-control-request-method": "POST" },
    });

    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("errores", () => {
  const expectApiError = (body: unknown, code: string) => {
    const parsed = apiErrorSchema.parse(body);
    expect(parsed.error.code).toBe(code);
    return parsed;
  };

  it("una ruta inexistente responde 404 not_found", async () => {
    const { app } = await makeApp();

    const response = await app.inject({ method: "GET", url: "/no-existe" });

    expect(response.statusCode).toBe(404);
    expectApiError(response.json(), "not_found");
  });

  it("un JSON inválido responde 400 invalid_request", async () => {
    const { app } = await makeApp();

    const response = await app.inject({ method: "POST", url: "/probe", headers: { "content-type": "application/json" }, payload: "{no es json" });

    expect(response.statusCode).toBe(400);
    expectApiError(response.json(), "invalid_request");
  });

  it("un cuerpo que no cumple el esquema responde 400 invalid_request sin detalles de zod", async () => {
    const { app } = await makeApp();

    const response = await app.inject({ method: "POST", url: "/probe", payload: { n: "no soy un número" } });

    expect(response.statusCode).toBe(400);
    const { error } = expectApiError(response.json(), "invalid_request");
    expect(JSON.stringify(error)).not.toMatch(/zod|expected|invalid_type|no soy un n/i);
  });

  it("un cuerpo mayor que bodyLimit responde 413 payload_too_large", async () => {
    const { app } = await makeApp({ app: { bodyLimitBytes: 1_024 } });

    const response = await app.inject({ method: "POST", url: "/probe", payload: { n: 1, relleno: "x".repeat(2_000) } });

    expect(response.statusCode).toBe(413);
    expectApiError(response.json(), "payload_too_large");
  });

  it("un Content-Type que no es JSON (incluido text/plain) responde 415 unsupported_media_type", async () => {
    const { app } = await makeApp();

    for (const type of ["application/xml", "text/plain"]) {
      const response = await app.inject({ method: "POST", url: "/probe", headers: { "content-type": type }, payload: "<n>1</n>" });
      expect(response.statusCode, type).toBe(415);
      expectApiError(response.json(), "unsupported_media_type");
    }
  });

  it("un error inesperado responde 500 internal_error sin stack, SQL ni datos, y el detalle queda en el log", async () => {
    const { app, logged } = await makeApp();

    const response = await app.inject({ method: "GET", url: "/boom" });

    expect(response.statusCode).toBe(500);
    expectApiError(response.json(), "internal_error");
    expect(response.body).not.toMatch(/SELECT|vehicle_state|6\.2518|password|stack|at /i);
    expect(logged().find((line) => line.level === "error" && line.msg === "Error no controlado en la petición")).toBeDefined();
  });

  it("un error de pg (con detalle de la fila) responde 500 genérico y no lo filtra", async () => {
    const { app } = await makeApp();

    const response = await app.inject({ method: "GET", url: "/pg-error" });

    expect(response.statusCode).toBe(500);
    expectApiError(response.json(), "internal_error");
    expect(response.body).not.toMatch(/duplicate|23505|code_hash|abc/i);
  });
});

describe("rate limit global por IP", () => {
  it("al superarse responde 429 rate_limited con Retry-After y el correlationId", async () => {
    const { app } = await makeApp({ app: { rateLimit: { max: 2, timeWindowMs: 60_000 } } });

    await app.inject({ method: "GET", url: "/boom" });
    await app.inject({ method: "GET", url: "/boom" });
    const response = await app.inject({ method: "GET", url: "/boom", headers: { "x-correlation-id": "flood-1" } });

    expect(response.statusCode).toBe(429);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe("rate_limited");
    expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
    expect(response.headers["x-correlation-id"]).toBe("flood-1");
  });
});
