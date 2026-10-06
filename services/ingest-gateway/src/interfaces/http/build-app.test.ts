import { apiErrorSchema, healthResponseSchema, type HealthResponse } from "@fleet/contracts";
import { createLogger } from "@fleet/platform";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildApp, type AppDependencies, type GatewayApp } from "./build-app.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const healthy: HealthResponse = { status: "ok", checks: { database: "up", kafka: "up" } };

let app: GatewayApp | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** Arma la app con un logger que guarda cada línea JSON, y rutas de prueba para los caminos de error. */
async function makeApp(overrides: Partial<AppDependencies> = {}) {
  const lines: string[] = [];
  const logger = createLogger({ service: "gateway-test", level: "info", destination: { write: (line: string) => void lines.push(line) } });
  app = await buildApp({
    logger,
    bodyLimitBytes: 1_024,
    rateLimit: { max: 100, timeWindowMs: 60_000 },
    checkHealth: () => Promise.resolve(healthy),
    registerRoutes: (instance) => {
      instance.post(
        "/probe",
        { schema: { body: z.object({ n: z.number() }), response: { 200: z.object({ ok: z.literal(true) }) } } },
        () => ({ ok: true as const }),
      );
      instance.get("/boom", () => {
        throw new Error("SELECT * FROM telemetry WHERE lat = 6.2518 AND lon = -75.5636: password authentication failed");
      });
      instance.get("/pg-error", () => {
        throw Object.assign(new Error("duplicate key value violates unique constraint"), {
          code: "23505",
          detail: "Key (event_id)=(3f2b8c1e-5d4a-4e7b-9a61-2c8d0e5f7a10) already exists.",
        });
      });
      instance.get(
        "/bad-response",
        { schema: { response: { 200: z.object({ n: z.number() }) } } },
        // NaN es un number para TypeScript, pero el esquema de zod lo rechaza: el handler incumple su respuesta.
        () => ({ n: Number.NaN }),
      );
    },
    ...overrides,
  });
  const logged = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { app, logged, raw: () => lines.join("") };
}

describe("GET /health", () => {
  it("responde 200 con los estados cuando todo responde, y cumple healthResponseSchema", async () => {
    const { app } = await makeApp();

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(healthResponseSchema.parse(response.json())).toEqual(healthy);
  });

  it("responde 503 con el mismo cuerpo cuando una dependencia cae", async () => {
    const degraded: HealthResponse = { status: "degraded", checks: { database: "up", kafka: "down" } };
    const { app } = await makeApp({ checkHealth: () => Promise.resolve(degraded) });

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(503);
    expect(healthResponseSchema.parse(response.json())).toEqual(degraded);
  });

  it("no cuenta para el rate limit", async () => {
    const { app } = await makeApp({ rateLimit: { max: 1, timeWindowMs: 60_000 } });

    for (let i = 0; i < 5; i++) {
      expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    }
  });
});

describe("correlationId", () => {
  it("toma un x-correlation-id válido, lo devuelve en la respuesta y lo pone en cada línea del log de la petición", async () => {
    const { app, logged } = await makeApp();

    const response = await app.inject({ method: "GET", url: "/health", headers: { "x-correlation-id": "web-1:abc_2.3" } });

    expect(response.headers["x-correlation-id"]).toBe("web-1:abc_2.3");
    const requestLines = logged().filter((line) => line.correlationId !== undefined);
    expect(requestLines.length).toBeGreaterThanOrEqual(2); // petición entrante y respuesta
    expect(requestLines.every((line) => line.correlationId === "web-1:abc_2.3")).toBe(true);
  });

  it.each([
    ["con espacios y salto de línea", "abc def\nghi"],
    ["con caracteres fuera del formato", "id/con/barras"],
    ["más largo que 128", "a".repeat(129)],
    ["vacío", ""],
  ])("genera uno nuevo si el header viene %s", async (_label, value) => {
    const { app, logged } = await makeApp();

    const response = await app.inject({ method: "GET", url: "/health", headers: { "x-correlation-id": value } });

    const id = response.headers["x-correlation-id"];
    expect(id).toMatch(UUID);
    expect(logged().some((line) => line.correlationId === id)).toBe(true);
    expect(JSON.stringify(logged())).not.toContain(value === "" ? "\u0000" : value);
  });

  it("genera uno cuando no viene el header, distinto en cada petición", async () => {
    const { app } = await makeApp();

    const [a, b] = await Promise.all([app.inject({ method: "GET", url: "/health" }), app.inject({ method: "GET", url: "/health" })]);

    expect(a.headers["x-correlation-id"]).toMatch(UUID);
    expect(a.headers["x-correlation-id"]).not.toBe(b.headers["x-correlation-id"]);
  });

  it("también lo llevan las respuestas de error", async () => {
    const { app } = await makeApp();

    const response = await app.inject({ method: "GET", url: "/no-existe", headers: { "x-correlation-id": "trace-9" } });

    expect(response.statusCode).toBe(404);
    expect(response.headers["x-correlation-id"]).toBe("trace-9");
  });
});

describe("logs de petición (privacidad)", () => {
  it("registran método, ruta y estado, pero ni la query, ni la IP, ni los headers", async () => {
    const { app, raw } = await makeApp();

    await app.inject({
      method: "GET",
      url: "/health?lat=6.2518&lon=-75.5636",
      headers: { authorization: "Bearer fdt_secreto", "user-agent": "agente-secreto" },
      remoteAddress: "203.0.113.7",
    });

    const text = raw();
    expect(text).toContain('"url":"/health"');
    expect(text).toContain('"statusCode":200');
    for (const forbidden of ["6.2518", "-75.5636", "203.0.113.7", "fdt_secreto", "agente-secreto", "authorization"]) {
      expect(text).not.toContain(forbidden);
    }
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

  it("un JSON inválido responde 400 invalid_envelope", async () => {
    const { app } = await makeApp();

    const response = await app.inject({ method: "POST", url: "/probe", headers: { "content-type": "application/json" }, payload: "{no es json" });

    expect(response.statusCode).toBe(400);
    expectApiError(response.json(), "invalid_envelope");
  });

  it("un cuerpo que no cumple el esquema responde 400 invalid_envelope sin detalles de zod", async () => {
    const { app } = await makeApp();

    const response = await app.inject({ method: "POST", url: "/probe", payload: { n: "no soy un número" } });

    expect(response.statusCode).toBe(400);
    const { error } = expectApiError(response.json(), "invalid_envelope");
    expect(JSON.stringify(error)).not.toMatch(/zod|expected|invalid_type|no soy un n/i);
  });

  it("un cuerpo mayor que bodyLimit responde 413 payload_too_large", async () => {
    const { app } = await makeApp({ bodyLimitBytes: 1_024 });

    const response = await app.inject({ method: "POST", url: "/probe", payload: { n: 1, relleno: "x".repeat(2_000) } });

    expect(response.statusCode).toBe(413);
    expectApiError(response.json(), "payload_too_large");
  });

  it("bodyLimit es configurable: el mismo cuerpo pasa con un tope mayor", async () => {
    const { app } = await makeApp({ bodyLimitBytes: 10_000 });

    const response = await app.inject({ method: "POST", url: "/probe", payload: { n: 1, relleno: "x".repeat(2_000) } });

    expect(response.statusCode).toBe(200);
  });

  it("un Content-Type que no es JSON responde 415 unsupported_media_type", async () => {
    const { app } = await makeApp();

    const response = await app.inject({ method: "POST", url: "/probe", headers: { "content-type": "application/xml" }, payload: "<n>1</n>" });

    expect(response.statusCode).toBe(415);
    expectApiError(response.json(), "unsupported_media_type");
  });

  it("text/plain, que Fastify parsea por defecto, responde 415 unsupported_media_type", async () => {
    const { app } = await makeApp();

    const response = await app.inject({ method: "POST", url: "/probe", headers: { "content-type": "text/plain" }, payload: '{"n":1}' });

    expect(response.statusCode).toBe(415);
    expectApiError(response.json(), "unsupported_media_type");
  });

  it("un error inesperado responde 500 internal_error sin stack, SQL ni datos, y el detalle queda en el log", async () => {
    const { app, logged } = await makeApp();

    const response = await app.inject({ method: "GET", url: "/boom" });

    expect(response.statusCode).toBe(500);
    expectApiError(response.json(), "internal_error");
    expect(response.body).not.toMatch(/SELECT|telemetry|6\.2518|password|stack|at .*\.ts/i);
    const errorLine = logged().find((line) => line.level === "error" && line.msg === "Error no controlado en la petición");
    expect(errorLine).toBeDefined();
  });

  it("un error de pg no filtra su código, su detalle ni su mensaje al cliente", async () => {
    const { app } = await makeApp();

    const response = await app.inject({ method: "GET", url: "/pg-error" });

    expect(response.statusCode).toBe(500);
    expectApiError(response.json(), "internal_error");
    expect(response.body).not.toMatch(/23505|event_id|3f2b8c1e|duplicate key|constraint/);
  });

  it("una respuesta que incumple su esquema se vuelve 500 internal_error y no se envía", async () => {
    const { app } = await makeApp();

    const response = await app.inject({ method: "GET", url: "/bad-response" });

    expect(response.statusCode).toBe(500);
    expectApiError(response.json(), "internal_error");
  });

  it("un fallo de checkHealth responde 500 internal_error", async () => {
    const { app } = await makeApp({ checkHealth: () => Promise.reject(new Error("no debería pasar")) });

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(500);
    expectApiError(response.json(), "internal_error");
  });
});

describe("rate limit", () => {
  it("responde 429 rate_limited con Retry-After (en segundos) al pasar el máximo por key", async () => {
    const { app } = await makeApp({ rateLimit: { max: 2, timeWindowMs: 60_000 } });
    const post = () => app.inject({ method: "POST", url: "/probe", payload: { n: 1 } });

    expect((await post()).statusCode).toBe(200);
    expect((await post()).statusCode).toBe(200);
    const limited = await post();

    expect(limited.statusCode).toBe(429);
    expect(apiErrorSchema.parse(limited.json()).error.code).toBe("rate_limited");
    const retryAfter = Number(limited.headers["retry-after"]);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(limited.headers["x-ratelimit-limit"]).toBe("2");
  });

  it("la key es configurable: cada key (p. ej. un dispositivo) tiene su propio contador", async () => {
    const { app } = await makeApp({
      rateLimit: {
        max: 1,
        timeWindowMs: 60_000,
        keyGenerator: (request) => String(request.headers["x-device"] ?? "anónimo"),
        hook: "preHandler",
      },
    });
    const post = (device: string) => app.inject({ method: "POST", url: "/probe", headers: { "x-device": device }, payload: { n: 1 } });

    expect((await post("dispositivo-a")).statusCode).toBe(200);
    expect((await post("dispositivo-a")).statusCode).toBe(429);
    expect((await post("dispositivo-b")).statusCode).toBe(200);
  });

  it("por defecto cuenta por IP de la conexión", async () => {
    const { app } = await makeApp({ rateLimit: { max: 1, timeWindowMs: 60_000 } });
    const post = (remoteAddress: string) => app.inject({ method: "POST", url: "/probe", remoteAddress, payload: { n: 1 } });

    expect((await post("203.0.113.1")).statusCode).toBe(200);
    expect((await post("203.0.113.1")).statusCode).toBe(429);
    expect((await post("203.0.113.2")).statusCode).toBe(200);
  });
});

describe("trustProxyHops (la IP del cliente detrás del balanceador)", () => {
  const post = (target: GatewayApp, forwardedFor: string) =>
    target.inject({ method: "POST", url: "/probe", remoteAddress: "10.0.0.5", headers: { "x-forwarded-for": forwardedFor }, payload: { n: 1 } });

  it("por defecto (0 saltos) ignora X-Forwarded-For: lo que diga el cliente no cambia su IP", async () => {
    const { app: instance } = await makeApp({ rateLimit: { max: 1, timeWindowMs: 60_000 } });

    expect((await post(instance, "203.0.113.1")).statusCode).toBe(200);
    expect((await post(instance, "203.0.113.2")).statusCode).toBe(429);
  });

  it("con 1 salto usa la IP que añadió el balanceador: dos clientes detrás de él cuentan por separado", async () => {
    const { app: instance } = await makeApp({ trustProxyHops: 1, rateLimit: { max: 1, timeWindowMs: 60_000 } });

    expect((await post(instance, "203.0.113.1")).statusCode).toBe(200);
    expect((await post(instance, "203.0.113.1")).statusCode).toBe(429);
    expect((await post(instance, "203.0.113.2")).statusCode).toBe(200);
  });

  it("con 1 salto, lo que el cliente antepone en X-Forwarded-For no sirve para evadir el límite", async () => {
    const { app: instance } = await makeApp({ trustProxyHops: 1, rateLimit: { max: 1, timeWindowMs: 60_000 } });

    expect((await post(instance, "1.1.1.1, 203.0.113.1")).statusCode).toBe(200);
    expect((await post(instance, "2.2.2.2, 203.0.113.1")).statusCode).toBe(429);
  });

  it("los logs de petición siguen sin llevar la IP con trustProxy activo", async () => {
    const { app: instance, raw } = await makeApp({ trustProxyHops: 1 });

    await post(instance, "203.0.113.77");

    expect(raw()).not.toContain("203.0.113.77");
  });
});
