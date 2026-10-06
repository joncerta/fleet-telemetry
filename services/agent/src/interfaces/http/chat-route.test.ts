import { agentHealthResponseSchema, apiErrorSchema, chatResponseSchema, livenessResponseSchema } from "@fleet/contracts";
import { createSessionCodec } from "@fleet/platform";
import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentCancelledError, AgentFailedError, AgentTimeoutError } from "../../application/errors.js";
import type { Chat } from "../../application/chat.js";
import type { BreakerStatus } from "../../application/ports.js";
import { ALLOWED_ORIGIN, CHAT_RESPONSE, makeTestApp, NORTE, SUR } from "../../testing/test-app.js";

const apps: { close(): Promise<void> }[] = [];

async function setup(options: Parameters<typeof makeTestApp>[0] = {}) {
  const made = await makeTestApp(options);
  apps.push(made.app);
  return made;
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const post = (made: Awaited<ReturnType<typeof setup>>, payload: unknown, headers: Record<string, string> = {}) =>
  made.app.inject({ method: "POST", url: "/v1/chat", payload: payload as object, headers });

describe("POST /v1/chat", () => {
  it("sin cookie responde 401 y no llama al caso de uso", async () => {
    const made = await setup();

    const response = await post(made, { message: "hola" });

    expect(response.statusCode).toBe(401);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe("unauthorized");
    expect(made.chat).not.toHaveBeenCalled();
  });

  it.each([
    ["una cookie con basura", "fleet_session=basura"],
    ["una cookie con otro nombre", "otra=abc"],
    ["una cookie vacía", "fleet_session="],
  ])("%s responde 401 con el mismo cuerpo", async (_label, cookie) => {
    const made = await setup();

    const response = await post(made, { message: "hola" }, { cookie });

    expect(response.statusCode).toBe(401);
    expect(made.chat).not.toHaveBeenCalled();
  });

  it("una cookie firmada con otro secreto o vencida responde 401", async () => {
    let nowMs = Date.parse("2026-10-06T12:00:00Z");
    const made = await setup({ now: () => nowMs });
    const cookie = made.sessionCookieOf(NORTE, Math.floor(nowMs / 1_000) + 60);

    expect((await post(made, { message: "hola" }, { cookie })).statusCode).toBe(200);
    nowMs += 120_000;
    expect((await post(made, { message: "hola" }, { cookie })).statusCode).toBe(401);

    const otherSecret = createSessionCodec("o".repeat(32));
    const forged = `fleet_session=${otherSecret.sign({ ...NORTE, exp: Math.floor(nowMs / 1_000) + 600 })}`;
    expect((await post(made, { message: "hola" }, { cookie: forged })).statusCode).toBe(401);
  });

  it("con sesión válida responde 200 con el contrato y delega con la identidad de la SESIÓN, no la del cuerpo", async () => {
    const made = await setup();
    const cookie = made.sessionCookieOf(NORTE);
    const token = cookie.split("=")[1];

    const response = await post(made, { message: "¿Qué vehículos?", tenantId: SUR.tenantId, userId: SUR.userId }, { cookie, "x-correlation-id": "corr-123" });

    expect(response.statusCode).toBe(200);
    expect(chatResponseSchema.parse(response.json())).toEqual(CHAT_RESPONSE);
    const call = vi.mocked(made.chat).mock.calls[0]?.[0];
    expect(call).toMatchObject({ context: { identity: NORTE, sessionToken: token, correlationId: "corr-123" }, message: "¿Qué vehículos?" });
    expect(call?.signal).toBeInstanceOf(AbortSignal);
  });

  it("el mismo texto con la sesión de otro tenant llega con ESA identidad", async () => {
    const made = await setup();

    await post(made, { message: "hola" }, { cookie: made.sessionCookieOf(SUR) });

    const call = vi.mocked(made.chat).mock.calls[0]?.[0];
    expect(call?.context.identity).toEqual(SUR);
  });

  it.each([
    ["sin mensaje", {}],
    ["mensaje vacío", { message: "" }],
    ["mensaje de más de 2000 caracteres", { message: "a".repeat(2_001) }],
    ["mensaje que no es texto", { message: 42 }],
  ])("%s responde 400 y no llama al caso de uso", async (_label, payload) => {
    const made = await setup();

    const response = await post(made, payload, { cookie: made.sessionCookieOf(NORTE) });

    expect(response.statusCode).toBe(400);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe("invalid_request");
    expect(made.chat).not.toHaveBeenCalled();
  });

  it("acepta exactamente 2000 caracteres", async () => {
    const made = await setup();

    const response = await post(made, { message: "a".repeat(2_000) }, { cookie: made.sessionCookieOf(NORTE) });

    expect(response.statusCode).toBe(200);
  });

  it("rechaza un cuerpo que no es JSON con 415", async () => {
    const made = await setup();

    const response = await made.app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: "message=hola",
      headers: { cookie: made.sessionCookieOf(NORTE), "content-type": "text/plain" },
    });

    expect(response.statusCode).toBe(415);
  });

  it("la sesión se comprueba antes de validar el cuerpo: un cuerpo inválido sin sesión es 401, no 400", async () => {
    const made = await setup();

    const response = await post(made, { message: "" });

    expect(response.statusCode).toBe(401);
  });

  describe("errores del agente", () => {
    const failing = (error: Error): Chat => () => Promise.reject(error);

    it("el tiempo total superado responde 504 con mensaje fijo", async () => {
      const made = await setup({ chat: failing(new AgentTimeoutError()) });

      const response = await post(made, { message: "hola" }, { cookie: made.sessionCookieOf(NORTE) });

      expect(response.statusCode).toBe(504);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe("agent_timeout");
    });

    it("una pregunta cancelada por el cliente se mapea a 503 con mensaje fijo", async () => {
      const made = await setup({ chat: failing(new AgentCancelledError()) });

      const response = await post(made, { message: "hola" }, { cookie: made.sessionCookieOf(NORTE) });

      expect(response.statusCode).toBe(503);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe("agent_unavailable");
    });

    it("un fallo del agente responde 503 sin el mensaje ni la causa originales", async () => {
      const cause = new Error("401 invalid x-api-key sk-ant-SECRETO con la pregunta del usuario");
      const made = await setup({ chat: failing(new AgentFailedError({ cause })) });

      const response = await post(made, { message: "pregunta sensible" }, { cookie: made.sessionCookieOf(NORTE) });

      expect(response.statusCode).toBe(503);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe("agent_unavailable");
      expect(response.body).not.toMatch(/SECRETO|sk-ant|x-api-key/);
      expect(made.raw()).not.toMatch(/SECRETO|sk-ant|pregunta sensible/);
    });

    it("un fallo con resumen deja en el log clase, estado, error.type y el tenant de la SESIÓN, sin la causa ni la pregunta", async () => {
      const cause = new Error("400 This API key is not scoped to a workspace: pregunta sensible");
      const failure = { causeName: "BadRequestError", causeStatus: 400, causeErrorType: "invalid_request_error", providerMisconfigured: false };
      const made = await setup({ chat: failing(new AgentFailedError({ cause, failure })) });

      const response = await post(made, { message: "pregunta sensible" }, { cookie: made.sessionCookieOf(NORTE) });

      expect(response.statusCode).toBe(503);
      const line = made.logged().find((entry) => entry["msg"] === "El agente no pudo responder");
      expect(line).toMatchObject({ level: "error", errorType: "AgentFailedError", tenantId: NORTE.tenantId, ...failure });
      expect(made.raw()).not.toMatch(/pregunta sensible|workspace/);
    });

    it("un AgentFailedError sin resumen (límite de pasos) se loguea sin campos de proveedor", async () => {
      const made = await setup({ chat: failing(new AgentFailedError()) });

      await post(made, { message: "hola" }, { cookie: made.sessionCookieOf(NORTE) });

      const line = made.logged().find((entry) => entry["msg"] === "El agente no pudo responder");
      expect(line).toMatchObject({ errorType: "AgentFailedError", tenantId: NORTE.tenantId });
      expect(line).not.toHaveProperty("causeStatus");
    });

    it("un 401 del proveedor se loguea con un mensaje propio y providerMisconfigured para alertar", async () => {
      const failure = { causeName: "AuthenticationError", causeStatus: 401, causeErrorType: "authentication_error", providerMisconfigured: true };
      const cause = new Error("401 invalid x-api-key sk-ant-SECRETO");
      const made = await setup({ chat: failing(new AgentFailedError({ cause, failure })) });

      const response = await post(made, { message: "hola" }, { cookie: made.sessionCookieOf(NORTE) });

      expect(response.statusCode).toBe(503);
      const line = made.logged().find((entry) => entry["msg"] === "El proveedor del modelo rechazó la configuración");
      expect(line).toMatchObject({ level: "error", tenantId: NORTE.tenantId, ...failure });
      expect(made.raw()).not.toMatch(/SECRETO|x-api-key/);
    });

    it("un error inesperado responde 500 sin stack ni mensaje", async () => {
      const made = await setup({ chat: failing(new Error("select * from secretos")) });

      const response = await post(made, { message: "hola" }, { cookie: made.sessionCookieOf(NORTE) });

      expect(response.statusCode).toBe(500);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe("internal_error");
      expect(response.body).not.toMatch(/select|stack| at /i);
    });
  });

  describe("rate limit por usuario", () => {
    it("tras el máximo responde 429 con Retry-After, y otro usuario no se ve afectado", async () => {
      const made = await setup({ userRateLimit: { max: 2, timeWindowMs: 60_000 } });
      const norte = { cookie: made.sessionCookieOf(NORTE) };

      expect((await post(made, { message: "uno" }, norte)).statusCode).toBe(200);
      expect((await post(made, { message: "dos" }, norte)).statusCode).toBe(200);
      const blocked = await post(made, { message: "tres" }, norte);

      expect(blocked.statusCode).toBe(429);
      expect(apiErrorSchema.parse(blocked.json()).error.code).toBe("rate_limited");
      expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
      expect(made.chat).toHaveBeenCalledTimes(2);
      expect((await post(made, { message: "uno" }, { cookie: made.sessionCookieOf(SUR) })).statusCode).toBe(200);
    });

    it("el límite es por usuario, no por IP: dos usuarios desde la misma IP tienen cada uno el suyo", async () => {
      const made = await setup({ userRateLimit: { max: 1, timeWindowMs: 60_000 } });
      const sameIp = { "x-forwarded-for": "192.0.2.50" };

      expect((await post(made, { message: "a" }, { ...sameIp, cookie: made.sessionCookieOf(NORTE) })).statusCode).toBe(200);
      expect((await post(made, { message: "a" }, { ...sameIp, cookie: made.sessionCookieOf(SUR) })).statusCode).toBe(200);
      expect((await post(made, { message: "b" }, { ...sameIp, cookie: made.sessionCookieOf(NORTE) })).statusCode).toBe(429);
    });

    it("sin sesión válida se limita por IP: un atacante que rota cookies falsas no evita el 429", async () => {
      const made = await setup({ userRateLimit: { max: 2, timeWindowMs: 60_000 } });
      const attacker = { "x-forwarded-for": "192.0.2.77" };

      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) statuses.push((await post(made, { message: "x" }, { ...attacker, cookie: `fleet_session=falsa${i}` })).statusCode);

      expect(statuses).toEqual([401, 401, 429, 429]);
    });

    it("la ventana se reinicia con el tiempo", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const made = await setup({ userRateLimit: { max: 1, timeWindowMs: 1_000 } });
      const norte = { cookie: made.sessionCookieOf(NORTE) };

      expect((await post(made, { message: "a" }, norte)).statusCode).toBe(200);
      expect((await post(made, { message: "b" }, norte)).statusCode).toBe(429);
      vi.setSystemTime(Date.now() + 1_500);

      expect((await post(made, { message: "c" }, norte)).statusCode).toBe(200);
    });
  });

  describe("CORS", () => {
    it("el origen de la web recibe Allow-Credentials y su propio origen; otro origen no recibe Allow-Origin", async () => {
      const made = await setup();

      const allowed = await made.app.inject({ method: "GET", url: "/health", headers: { origin: ALLOWED_ORIGIN } });
      const denied = await made.app.inject({ method: "GET", url: "/health", headers: { origin: "http://evil.test" } });

      expect(allowed.headers["access-control-allow-origin"]).toBe(ALLOWED_ORIGIN);
      expect(allowed.headers["access-control-allow-credentials"]).toBe("true");
      expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("el preflight de POST /v1/chat desde la web lo permite con credenciales y los headers del contrato", async () => {
      const made = await setup();

      const response = await made.app.inject({
        method: "OPTIONS",
        url: "/v1/chat",
        headers: { origin: ALLOWED_ORIGIN, "access-control-request-method": "POST", "access-control-request-headers": "content-type,x-correlation-id" },
      });

      expect(response.statusCode).toBe(204);
      expect(response.headers["access-control-allow-origin"]).toBe(ALLOWED_ORIGIN);
      expect(response.headers["access-control-allow-credentials"]).toBe("true");
      expect(String(response.headers["access-control-allow-methods"])).toContain("POST");
    });

    it("el preflight desde otro origen no recibe Allow-Origin", async () => {
      const made = await setup();

      const response = await made.app.inject({
        method: "OPTIONS",
        url: "/v1/chat",
        headers: { origin: "http://evil.test", "access-control-request-method": "POST" },
      });

      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("un 429 también lleva las cabeceras CORS: el navegador puede leerlo", async () => {
      const made = await setup({ userRateLimit: { max: 1, timeWindowMs: 60_000 } });
      const headers = { cookie: made.sessionCookieOf(NORTE), origin: ALLOWED_ORIGIN };

      await post(made, { message: "a" }, headers);
      const blocked = await post(made, { message: "b" }, headers);

      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers["access-control-allow-origin"]).toBe(ALLOWED_ORIGIN);
    });
  });

  describe("logs", () => {
    it("registran conteos, herramientas, estado del breaker y duración, nunca la pregunta ni la respuesta", async () => {
      const made = await setup();

      await post(made, { message: "pregunta secreta sobre la placa ABC123" }, { cookie: made.sessionCookieOf(NORTE), "x-correlation-id": "corr-log-1" });

      const line = made.logged().find((entry) => entry["msg"] === "Pregunta respondida");
      expect(line).toMatchObject({
        correlationId: "corr-log-1",
        tenantId: NORTE.tenantId,
        toolCalls: 1,
        tools: ["get_stopped_vehicles:ok"],
        breaker: "closed",
      });
      expect(line?.["durationMs"]).toEqual(expect.any(Number));
      const raw = made.raw();
      expect(raw).not.toMatch(/pregunta secreta|ABC123|Hay 1 vehículo/);
      expect(raw).not.toContain(made.sessionCookieOf(NORTE).split("=")[1]);
    });

    it("no loguean la cookie ni la query", async () => {
      const made = await setup();
      const cookie = made.sessionCookieOf(NORTE);

      await made.app.inject({ method: "POST", url: "/v1/chat?secreto=1", payload: { message: "hola" }, headers: { cookie } });

      expect(made.raw()).not.toContain("secreto=1");
      expect(made.raw()).not.toContain(cookie.split("=")[1]);
    });
  });

  it("toda respuesta lleva Cache-Control: no-store y el correlationId", async () => {
    const made = await setup();

    const response = await post(made, { message: "hola" }, { cookie: made.sessionCookieOf(NORTE), "x-correlation-id": "corr-77" });

    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-correlation-id"]).toBe("corr-77");
  });
});

describe("cancelación por cierre del cliente", () => {
  it("si el cliente cierra la conexión, el caso de uso recibe el signal abortado", async () => {
    let received: AbortSignal | undefined;
    const started = Promise.withResolvers<void>();
    const chat: Chat = ({ signal }) => {
      received = signal;
      started.resolve();
      return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new AgentCancelledError())));
    };
    const made = await setup({ chat });
    await made.app.listen({ host: "127.0.0.1", port: 0 });
    const address = made.app.server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    const request = http.request({ host: "127.0.0.1", port, path: "/v1/chat", method: "POST", headers: { "content-type": "application/json", cookie: made.sessionCookieOf(NORTE) } });
    request.on("error", () => undefined);
    request.end(JSON.stringify({ message: "hola" }));
    await started.promise;
    expect(received?.aborted).toBe(false);

    request.destroy();

    await vi.waitFor(() => expect(received?.aborted).toBe(true));
  });

  it("una pregunta respondida con normalidad no deja el signal abortado", async () => {
    let received: AbortSignal | undefined;
    const made = await setup({
      chat: ({ signal }) => {
        received = signal;
        return Promise.resolve(CHAT_RESPONSE);
      },
    });

    await post(made, { message: "hola" }, { cookie: made.sessionCookieOf(NORTE) });

    expect(received).toBeDefined();
    expect(received?.aborted).toBe(false);
  });
});

describe("GET /health y /health/live", () => {
  const breakerIn = (state: "closed" | "open" | "halfOpen"): BreakerStatus => ({ state: () => state });

  it("con el breaker cerrado responde 200 ok y refleja el estado en dependencies.fleetApi", async () => {
    const made = await setup({ breaker: breakerIn("closed") });

    const response = await made.app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(agentHealthResponseSchema.parse(response.json())).toEqual({
      status: "ok",
      checks: { fleetApi: "up", model: "up" },
      dependencies: { fleetApi: { breaker: "closed" }, model: { breaker: "closed" } },
    });
  });

  it("con el breaker del modelo abierto responde 503 degraded aunque fleet-api esté bien", async () => {
    const made = await setup({ breaker: breakerIn("closed"), modelBreaker: breakerIn("open") });

    const response = await made.app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(503);
    expect(agentHealthResponseSchema.parse(response.json())).toEqual({
      status: "degraded",
      checks: { fleetApi: "up", model: "down" },
      dependencies: { fleetApi: { breaker: "closed" }, model: { breaker: "open" } },
    });
  });

  it("con el breaker del modelo en halfOpen sigue ok y lo refleja", async () => {
    const made = await setup({ modelBreaker: breakerIn("halfOpen") });

    const response = await made.app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(agentHealthResponseSchema.parse(response.json()).dependencies.model?.breaker).toBe("halfOpen");
  });

  it("con el breaker abierto responde 503 degraded con el mismo cuerpo", async () => {
    const made = await setup({ breaker: breakerIn("open") });

    const response = await made.app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(503);
    expect(agentHealthResponseSchema.parse(response.json())).toEqual({
      status: "degraded",
      checks: { fleetApi: "down", model: "up" },
      dependencies: { fleetApi: { breaker: "open" }, model: { breaker: "closed" } },
    });
  });

  it("en halfOpen sigue ok: el circuito ya deja pasar una prueba", async () => {
    const made = await setup({ breaker: breakerIn("halfOpen") });

    const response = await made.app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(agentHealthResponseSchema.parse(response.json()).dependencies.fleetApi.breaker).toBe("halfOpen");
  });

  it("/health/live responde 200 aunque el breaker esté abierto: no depende de fleet-api", async () => {
    const made = await setup({ breaker: breakerIn("open") });

    const response = await made.app.inject({ method: "GET", url: "/health/live" });

    expect(response.statusCode).toBe(200);
    // `livenessResponseSchema` (como el gateway y fleet-api): solo `status`, sin `checks`.
    expect(livenessResponseSchema.parse(response.json())).toEqual({ status: "ok" });
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("la salud no pide sesión, no lleva datos sensibles y no cuenta para el rate limit", async () => {
    const made = await setup({ app: { rateLimit: { max: 1, timeWindowMs: 60_000 } } });

    for (let i = 0; i < 5; i++) expect((await made.app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    const body = (await made.app.inject({ method: "GET", url: "/health" })).body;

    expect(body).not.toMatch(/http|127\.0\.0\.1|secret|token/i);
  });
});

describe("rutas desconocidas", () => {
  it("responden 404 con apiErrorSchema", async () => {
    const made = await setup();

    const response = await made.app.inject({ method: "GET", url: "/no-existe" });

    expect(response.statusCode).toBe(404);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe("not_found");
  });
});
