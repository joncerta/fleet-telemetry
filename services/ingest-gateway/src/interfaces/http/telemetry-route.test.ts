import { apiErrorSchema, batchAckSchema, MAX_BATCH_POINTS, type BatchAck } from "@fleet/contracts";
import { createLogger } from "@fleet/platform";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthenticateDevice } from "../../application/authenticate-device.js";
import { DeviceDirectoryUnavailableError, PublicationFailedError } from "../../application/errors.js";
import type { DeviceRepository } from "../../application/ports.js";
import type { ReceiveTelemetryBatchInput } from "../../application/receive-telemetry-batch.js";
import type { DeviceContext } from "../../domain/device.js";
import { createFixedWindowFailureCounter } from "../../infrastructure/fixed-window-failure-counter.js";
import { createLimitedDeviceRepository } from "../../infrastructure/limited-device-repository.js";
import { buildApp, type GatewayApp } from "./build-app.js";
import { bearerToken, registerTelemetryRoute, TELEMETRY_BATCHES_PATH, type TelemetryRouteDependencies } from "./telemetry-route.js";

const TOKEN = "fdt_Zk3Qx9Wm2LpR7vTn4YbHc8DfJ1sAe6UoG0iNhXwVqKE";
const OTHER_TOKEN = "fdt_Aa3Qx9Wm2LpR7vTn4YbHc8DfJ1sAe6UoG0iNhXwVqKE";
const DEVICE: DeviceContext = {
  tenantId: "9d7e1b34-2a6c-4f08-b5d3-6e4a8c1f0b92",
  deviceId: "5b8a3f6c-1e9d-4a27-8c40-7f2e6d1b9a35",
  vehicleId: "a1c4e9d2-7b3f-4c58-8e16-0d9f2b6a4c71",
};
const OTHER_DEVICE: DeviceContext = { ...DEVICE, deviceId: "11111111-2222-4333-8444-555555555555", vehicleId: "22222222-3333-4444-8555-666666666666" };
const EVENT = "3f2b8c1e-5d4a-4e7b-9a61-2c8d0e5f7a10";

const envelope = (points: unknown[] = [{ eventId: EVENT, lat: 6.2518, lon: -75.5636 }]) => ({ schemaVersion: 1, sentAt: "2026-03-14T19:59:59.000Z", points });
const ACK: BatchAck = { schemaVersion: 1, accepted: [EVENT], rejected: [{ index: 1, eventId: null, reason: "invalid_schema", detail: "Campos inválidos: lat." }], serverTime: "2026-03-14T20:00:00.000Z" };
const bearer = (token = TOKEN) => ({ authorization: `Bearer ${token}` });
/** Con formato válido pero que ningún dispositivo tiene: el repositorio no lo encuentra (401). */
const UNKNOWN_TOKEN = "fdt_Zz3Qx9Wm2LpR7vTn4YbHc8DfJ1sAe6UoG0iNhXwVqKE";

let app: GatewayApp | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

interface Options {
  authenticate?: TelemetryRouteDependencies["authenticate"];
  receiveBatch?: TelemetryRouteDependencies["receiveBatch"];
  deviceRateLimit?: TelemetryRouteDependencies["deviceRateLimit"];
  /** Tope alto por IP contra floods: cuenta TODAS las peticiones. */
  ipRateLimit?: { max: number; timeWindowMs: number };
  /** Límite por IP de fallos de autenticación (401). */
  authFailureLimit?: { max: number; timeWindowMs: number };
  trustProxyHops?: number;
  bodyLimitBytes?: number;
}

async function makeApp(options: Options = {}) {
  const lines: string[] = [];
  const logger = createLogger({ service: "gateway-route-test", level: "info", destination: { write: (line: string) => void lines.push(line) } });
  const registry = new Map<string, DeviceContext>([
    [TOKEN, DEVICE],
    [OTHER_TOKEN, OTHER_DEVICE],
  ]);
  const authenticateCalls: (string | undefined)[] = [];
  const received: ReceiveTelemetryBatchInput[] = [];

  const instance = await buildApp({
    logger,
    bodyLimitBytes: options.bodyLimitBytes ?? 100_000,
    rateLimit: options.ipRateLimit ?? { max: 1_000, timeWindowMs: 60_000 },
    ...(options.trustProxyHops !== undefined && { trustProxyHops: options.trustProxyHops }),
    checkHealth: () => Promise.resolve({ status: "ok", checks: {} }),
    registerRoutes: (inner) =>
      registerTelemetryRoute(inner, {
        authenticate:
          options.authenticate ??
          ((token) => {
            authenticateCalls.push(token);
            return Promise.resolve(token === undefined ? null : (registry.get(token) ?? null));
          }),
        receiveBatch:
          options.receiveBatch ??
          ((input) => {
            received.push(input);
            return Promise.resolve(ACK);
          }),
        deviceRateLimit: options.deviceRateLimit ?? { max: 1_000, timeWindowMs: 60_000 },
        authFailureLimiter: createFixedWindowFailureCounter(options.authFailureLimit ?? { max: 1_000, timeWindowMs: 60_000 }),
      }),
  });
  app = instance;
  const post = (payload: object, headers: Record<string, string> = bearer(), extra: { remoteAddress?: string } = {}) =>
    instance.inject({ method: "POST", url: TELEMETRY_BATCHES_PATH, headers, payload, ...extra });
  return { app: instance, post, received, authenticateCalls, logged: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>), raw: () => lines.join("") };
}

const errorCode = (body: unknown) => apiErrorSchema.parse(body).error.code;

/** `Retry-After` en segundos enteros y positivos: el móvil lo usa para el backoff de su cola. */
function expectRetryAfter(header: unknown): void {
  const seconds = Number(header);
  expect(Number.isInteger(seconds)).toBe(true);
  expect(seconds).toBeGreaterThanOrEqual(1);
}

describe("bearerToken", () => {
  it.each([
    ["Bearer abc", "abc"],
    ["bearer abc", "abc"],
    ["BEARER abc", "abc"],
  ])("extrae el token de %j", (header, expected) => {
    expect(bearerToken(header)).toBe(expected);
  });

  it.each([[undefined], [""], ["Bearer"], ["Bearer "], ["Basic abc"], ["Bearer a b"], ["abc"], ["Bearer  abc"]])("no extrae nada de %j", (header) => {
    expect(bearerToken(header)).toBeUndefined();
  });
});

describe("POST /v1/telemetry/batches: autenticación", () => {
  it.each([
    ["sin header Authorization", {}],
    ["con esquema Basic", { authorization: `Basic ${TOKEN}` }],
    ["con Bearer vacío", { authorization: "Bearer " }],
    ["con token malformado", { authorization: "Bearer fdt_corto" }],
    ["con token sin prefijo", { authorization: `Bearer ${TOKEN.slice(4)}` }],
    ["con token desconocido o revocado (el repositorio no lo encuentra)", bearer("fdt_Zz3Qx9Wm2LpR7vTn4YbHc8DfJ1sAe6UoG0iNhXwVqKE")],
  ])("responde 401 unauthorized %s, y nunca llega al caso de uso", async (_label, headers) => {
    const { post, received } = await makeApp();

    const response = await post(envelope(), headers);

    expect(response.statusCode).toBe(401);
    expect(errorCode(response.json())).toBe("unauthorized");
    expect(received).toEqual([]);
  });

  it("todas las variantes de 401 devuelven exactamente el mismo cuerpo (no filtran si el token existe)", async () => {
    const { post } = await makeApp();

    const bodies = await Promise.all(
      [{}, bearer("fdt_corto"), bearer("fdt_Zz3Qx9Wm2LpR7vTn4YbHc8DfJ1sAe6UoG0iNhXwVqKE")].map(async (headers) => (await post(envelope(), headers)).body),
    );

    expect(new Set(bodies).size).toBe(1);
  });

  it("autentica antes de validar el cuerpo: sin token, un JSON inválido también es 401 (no 400)", async () => {
    const { app, authenticateCalls } = await makeApp();

    const response = await app.inject({ method: "POST", url: TELEMETRY_BATCHES_PATH, headers: { "content-type": "application/json" }, payload: "{no es json" });

    expect(response.statusCode).toBe(401);
    expect(authenticateCalls).toEqual([undefined]);
  });

  it("un 401 lleva el correlationId y no deja el token en el log", async () => {
    const { post, raw } = await makeApp();

    const response = await post(envelope(), { ...bearer(OTHER_TOKEN.replace("Aa3", "Bb3")), "x-correlation-id": "corr-401" });

    expect(response.headers["x-correlation-id"]).toBe("corr-401");
    expect(raw()).not.toContain("Bb3Qx9Wm2LpR7vTn");
    expect(raw()).not.toMatch(/authorization/i);
  });
});

describe("POST /v1/telemetry/batches: camino feliz", () => {
  it("responde 202 con un ACK que cumple batchAckSchema", async () => {
    const { post } = await makeApp();

    const response = await post(envelope());

    expect(response.statusCode).toBe(202);
    expect(batchAckSchema.parse(response.json())).toEqual(ACK);
  });

  it("entrega al caso de uso la identidad del TOKEN y el correlationId de la petición, no lo que digan el body o los headers", async () => {
    const { post, received } = await makeApp();
    const body = { ...envelope(), tenantId: "99999999-9999-4999-8999-999999999999", deviceId: "88888888-8888-4888-8888-888888888888" };

    await post(body, { ...bearer(), "x-tenant-id": "77777777-7777-4777-8777-777777777777", "x-correlation-id": "corr-ok-1" });

    expect(received).toHaveLength(1);
    expect(received[0]?.device).toEqual(DEVICE);
    expect(received[0]?.correlationId).toBe("corr-ok-1");
    expect(received[0]?.envelope.points).toHaveLength(1);
  });

  it("la identidad es la del token de cada petición", async () => {
    const { post, received } = await makeApp();

    await post(envelope(), bearer(TOKEN));
    await post(envelope(), bearer(OTHER_TOKEN));

    expect(received.map((input) => input.device)).toEqual([DEVICE, OTHER_DEVICE]);
  });

  it("registra conteos, tenant, dispositivo y vehículo, y nunca coordenadas, el punto ni el token", async () => {
    const { post, logged, raw } = await makeApp();

    await post(envelope([{ eventId: EVENT, lat: 6.2518, lon: -75.5636 }, { eventId: "no-uuid" }]), { ...bearer(), "x-correlation-id": "corr-log" });

    const line = logged().find((entry) => entry.msg === "Lote de telemetría aceptado");
    expect(line).toMatchObject({
      tenantId: DEVICE.tenantId,
      deviceId: DEVICE.deviceId,
      vehicleId: DEVICE.vehicleId,
      correlationId: "corr-log",
      received: 2,
      accepted: 1,
      rejected: 1,
      rejectedByReason: { invalid_schema: 1 },
      duplicatesInBatch: 0,
    });
    for (const forbidden of ["6.2518", "-75.5636", TOKEN, "Bearer"]) expect(raw()).not.toContain(forbidden);
  });

  it("cuenta como duplicados del lote los puntos que no son aceptados ni rechazados", async () => {
    const { post, logged } = await makeApp({
      receiveBatch: () => Promise.resolve({ schemaVersion: 1, accepted: [EVENT], rejected: [], serverTime: ACK.serverTime }),
    });

    await post(envelope([{ a: 1 }, { a: 2 }, { a: 3 }]));

    expect(logged().find((entry) => entry.msg === "Lote de telemetría aceptado")).toMatchObject({ received: 3, accepted: 1, rejected: 0, duplicatesInBatch: 2 });
  });
});

describe("POST /v1/telemetry/batches: envelope inválido (400, sin DLQ)", () => {
  it("un JSON inválido responde 400 invalid_envelope", async () => {
    const { app, received } = await makeApp();

    const response = await app.inject({ method: "POST", url: TELEMETRY_BATCHES_PATH, headers: { ...bearer(), "content-type": "application/json" }, payload: "{no es json" });

    expect(response.statusCode).toBe(400);
    expect(errorCode(response.json())).toBe("invalid_envelope");
    expect(received).toEqual([]);
  });

  it.each([
    ["sin schemaVersion", { sentAt: "2026-03-14T19:59:59.000Z", points: [{}] }],
    ["con schemaVersion 2", { ...envelope(), schemaVersion: 2 }],
    ["sin sentAt", { schemaVersion: 1, points: [{}] }],
    ["sin points", { schemaVersion: 1, sentAt: "2026-03-14T19:59:59.000Z" }],
    ["con points que no es un arreglo", { ...envelope(), points: "x" }],
    ["con points vacío", envelope([])],
    [`con más de ${MAX_BATCH_POINTS} puntos`, envelope(Array.from({ length: MAX_BATCH_POINTS + 1 }, () => ({})))],
    ["que es un arreglo", [1, 2]],
  ])("un envelope %s responde 400 invalid_envelope y no llega al caso de uso", async (_label, body) => {
    const { post, received } = await makeApp({ bodyLimitBytes: 1_000_000 });

    const response = await post(body);

    expect(response.statusCode).toBe(400);
    expect(errorCode(response.json())).toBe("invalid_envelope");
    expect(received).toEqual([]);
  });

  it("un lote de exactamente 500 puntos es válido", async () => {
    const { post, received } = await makeApp({ bodyLimitBytes: 1_000_000 });

    const response = await post(envelope(Array.from({ length: MAX_BATCH_POINTS }, () => ({}))));

    expect(response.statusCode).toBe(202);
    expect(received[0]?.envelope.points).toHaveLength(MAX_BATCH_POINTS);
  });

  it("los puntos inválidos NO invalidan el envelope: los decide el caso de uso", async () => {
    const { post, received } = await makeApp();

    const response = await post(envelope([null, 5, "x", {}]));

    expect(response.statusCode).toBe(202);
    expect(received[0]?.envelope.points).toEqual([null, 5, "x", {}]);
  });

  it("el cuerpo del 400 no cita nada del envelope ni de zod", async () => {
    const { post } = await makeApp();

    const response = await post({ schemaVersion: 7, sentAt: "ayer", points: [{ lat: 6.2518 }] });

    expect(response.body).not.toMatch(/zod|expected|invalid_type|6\.2518|ayer/i);
  });
});

describe("POST /v1/telemetry/batches: límites del cuerpo y tipo de contenido", () => {
  it("un cuerpo mayor que el límite responde 413 payload_too_large", async () => {
    const { post } = await makeApp({ bodyLimitBytes: 1_024 });

    const response = await post(envelope([{ relleno: "x".repeat(2_000) }]));

    expect(response.statusCode).toBe(413);
    expect(errorCode(response.json())).toBe("payload_too_large");
  });

  it.each([
    ["text/plain (que Fastify parsea por defecto)", "text/plain"],
    ["text/plain con charset", "text/plain; charset=utf-8"],
    ["application/xml", "application/xml"],
    ["application/x-www-form-urlencoded", "application/x-www-form-urlencoded"],
    ["multipart/form-data", "multipart/form-data; boundary=x"],
  ])("%s responde 415 unsupported_media_type aunque el cuerpo sea JSON válido", async (_label, contentType) => {
    const { app, received } = await makeApp();

    const response = await app.inject({ method: "POST", url: TELEMETRY_BATCHES_PATH, headers: { ...bearer(), "content-type": contentType }, payload: JSON.stringify(envelope()) });

    expect(response.statusCode).toBe(415);
    expect(errorCode(response.json())).toBe("unsupported_media_type");
    expect(received).toEqual([]);
  });

  it("un cuerpo sin Content-Type responde 415", async () => {
    const { app } = await makeApp();

    const response = await app.inject({ method: "POST", url: TELEMETRY_BATCHES_PATH, headers: bearer(), payload: Buffer.from(JSON.stringify(envelope())) });

    expect(response.statusCode).toBe(415);
  });

  it("application/json con charset sí se acepta", async () => {
    const { app } = await makeApp();

    const response = await app.inject({
      method: "POST",
      url: TELEMETRY_BATCHES_PATH,
      headers: { ...bearer(), "content-type": "application/json; charset=utf-8" },
      payload: JSON.stringify(envelope()),
    });

    expect(response.statusCode).toBe(202);
  });
});

describe("POST /v1/telemetry/batches: rate limit", () => {
  it("por dispositivo: el segundo lote de un dispositivo con max=1 responde 429 rate_limited con Retry-After", async () => {
    const { post, received } = await makeApp({ deviceRateLimit: { max: 1, timeWindowMs: 60_000 } });

    expect((await post(envelope())).statusCode).toBe(202);
    const limited = await post(envelope());

    expect(limited.statusCode).toBe(429);
    expect(errorCode(limited.json())).toBe("rate_limited");
    const retryAfter = Number(limited.headers["retry-after"]);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(limited.headers["x-ratelimit-limit"]).toBe("1");
    expect(limited.headers["x-correlation-id"]).toBeDefined();
    expect(received).toHaveLength(1);
  });

  it("cada dispositivo tiene su propio contador, aunque compartan IP", async () => {
    const { post } = await makeApp({ deviceRateLimit: { max: 1, timeWindowMs: 60_000 } });

    expect((await post(envelope(), bearer(TOKEN))).statusCode).toBe(202);
    expect((await post(envelope(), bearer(TOKEN))).statusCode).toBe(429);
    expect((await post(envelope(), bearer(OTHER_TOKEN))).statusCode).toBe(202);
  });

  it("el límite por dispositivo no depende de la IP: el mismo dispositivo desde otra IP sigue limitado", async () => {
    const { post } = await makeApp({ deviceRateLimit: { max: 1, timeWindowMs: 60_000 } });

    expect((await post(envelope(), bearer(), { remoteAddress: "203.0.113.1" })).statusCode).toBe(202);
    expect((await post(envelope(), bearer(), { remoteAddress: "203.0.113.2" })).statusCode).toBe(429);
  });

  it("por IP: tras superar el límite de 401, un token INVÁLIDO recibe 429 con Retry-After en vez de 401, y el token se sigue consultando", async () => {
    const { post, authenticateCalls } = await makeApp({ authFailureLimit: { max: 2, timeWindowMs: 60_000 } });
    const guess = () => post(envelope(), bearer(UNKNOWN_TOKEN), { remoteAddress: "198.51.100.9" });

    expect((await guess()).statusCode).toBe(401);
    expect((await guess()).statusCode).toBe(401);
    const limited = await guess();

    expect(limited.statusCode).toBe(429);
    expect(errorCode(limited.json())).toBe("rate_limited");
    expectRetryAfter(limited.headers["retry-after"]);
    expect(limited.headers["x-correlation-id"]).toBeDefined();
    // Con la IP bloqueada igual se autentica: así un token válido de la misma IP (CGNAT) no queda fuera.
    expect(authenticateCalls).toHaveLength(3);
  });

  it("por IP: con la IP por encima del límite de 401, un token VÁLIDO pasa (202) y uno inválido recibe 429", async () => {
    const { post, received } = await makeApp({ authFailureLimit: { max: 2, timeWindowMs: 60_000 } });
    const from = { remoteAddress: "198.51.100.9" };
    expect((await post(envelope(), bearer(UNKNOWN_TOKEN), from)).statusCode).toBe(401);
    expect((await post(envelope(), bearer(UNKNOWN_TOKEN), from)).statusCode).toBe(401);
    expect((await post(envelope(), bearer(UNKNOWN_TOKEN), from)).statusCode).toBe(429);

    // Dispositivos legítimos de tenants distintos detrás de la misma IP pública (CGNAT) no se ven afectados.
    expect((await post(envelope(), bearer(TOKEN), from)).statusCode).toBe(202);
    expect((await post(envelope(), bearer(OTHER_TOKEN), from)).statusCode).toBe(202);
    expect((await post(envelope(), bearer(UNKNOWN_TOKEN), from)).statusCode).toBe(429);
    expect(received).toHaveLength(2);
  });

  it("muchos 202 desde una misma IP NO dan 429: el límite por IP solo cuenta los 401", async () => {
    const { post, received } = await makeApp({ authFailureLimit: { max: 2, timeWindowMs: 60_000 } });

    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) statuses.push((await post(envelope(), bearer(), { remoteAddress: "198.51.100.9" })).statusCode);

    expect(statuses).toEqual(Array.from({ length: 12 }, () => 202));
    expect(received).toHaveLength(12);
  });

  it("los 202 de una IP no restan del presupuesto de 401: tras muchos 202, todavía caben max 401", async () => {
    const { post } = await makeApp({ authFailureLimit: { max: 2, timeWindowMs: 60_000 } });
    const from = { remoteAddress: "198.51.100.9" };
    for (let i = 0; i < 5; i += 1) expect((await post(envelope(), bearer(), from)).statusCode).toBe(202);

    expect((await post(envelope(), bearer(UNKNOWN_TOKEN), from)).statusCode).toBe(401);
    expect((await post(envelope(), bearer(UNKNOWN_TOKEN), from)).statusCode).toBe(401);
    expect((await post(envelope(), bearer(UNKNOWN_TOKEN), from)).statusCode).toBe(429);
  });

  it("muchos 401 desde una misma IP sí dan 429, y otra IP no se ve afectada", async () => {
    const { post } = await makeApp({ authFailureLimit: { max: 3, timeWindowMs: 60_000 } });

    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) statuses.push((await post(envelope(), bearer(UNKNOWN_TOKEN), { remoteAddress: "198.51.100.9" })).statusCode);

    expect(statuses).toEqual([401, 401, 401, 429, 429, 429]);
    expect((await post(envelope(), bearer(), { remoteAddress: "198.51.100.10" })).statusCode).toBe(202);
  });

  it("dos IPv6 del mismo /64 cuentan juntas (los 401); otro /64 no se ve afectado", async () => {
    const { post } = await makeApp({ authFailureLimit: { max: 2, timeWindowMs: 60_000 } });
    const guess = (remoteAddress: string) => post(envelope(), bearer(UNKNOWN_TOKEN), { remoteAddress });

    expect((await guess("2001:db8:1:2::1")).statusCode).toBe(401);
    expect((await guess("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).statusCode).toBe(401);
    expect((await guess("2001:db8:1:2:1234::9")).statusCode).toBe(429);

    expect((await guess("2001:db8:1:3::1")).statusCode).toBe(401);
  });

  it("una IPv4 y la misma IPv4 mapeada en IPv6 cuentan juntas (los 401)", async () => {
    const { post } = await makeApp({ authFailureLimit: { max: 2, timeWindowMs: 60_000 } });
    const guess = (remoteAddress: string) => post(envelope(), bearer(UNKNOWN_TOKEN), { remoteAddress });

    expect((await guess("198.51.100.9")).statusCode).toBe(401);
    expect((await guess("::ffff:198.51.100.9")).statusCode).toBe(401);
    expect((await guess("198.51.100.9")).statusCode).toBe(429);
  });

  it("el tope contra floods también agrupa las IPv6 por /64, y trata igual la IPv4 y su forma mapeada", async () => {
    const { post } = await makeApp({ ipRateLimit: { max: 2, timeWindowMs: 60_000 } });

    expect((await post(envelope(), bearer(), { remoteAddress: "2001:db8:1:2::1" })).statusCode).toBe(202);
    expect((await post(envelope(), bearer(), { remoteAddress: "2001:db8:1:2:ffff::7" })).statusCode).toBe(202);
    expect((await post(envelope(), bearer(), { remoteAddress: "2001:db8:1:2:1:2:3:4" })).statusCode).toBe(429);

    expect((await post(envelope(), bearer(), { remoteAddress: "198.51.100.9" })).statusCode).toBe(202);
    expect((await post(envelope(), bearer(), { remoteAddress: "::ffff:198.51.100.9" })).statusCode).toBe(202);
    expect((await post(envelope(), bearer(), { remoteAddress: "198.51.100.9" })).statusCode).toBe(429);
  });

  it("un token mal formado y un header ausente también cuentan como 401 de la IP", async () => {
    const { post } = await makeApp({ authFailureLimit: { max: 2, timeWindowMs: 60_000 } });
    const from = { remoteAddress: "198.51.100.9" };

    expect((await post(envelope(), {}, from)).statusCode).toBe(401);
    expect((await post(envelope(), bearer("fdt_corto"), from)).statusCode).toBe(401);
    // Con la IP ya por encima del límite, un token válido pasa; uno inválido recibe 429.
    expect((await post(envelope(), bearer(), from)).statusCode).toBe(202);
    expect((await post(envelope(), bearer(UNKNOWN_TOKEN), from)).statusCode).toBe(429);
  });

  it("el tope alto por IP contra floods sigue existiendo: cuenta todas las peticiones, también las 202", async () => {
    const { post } = await makeApp({ ipRateLimit: { max: 3, timeWindowMs: 60_000 } });
    const from = { remoteAddress: "198.51.100.9" };

    expect((await post(envelope(), bearer(), from)).statusCode).toBe(202);
    expect((await post(envelope(), bearer(), from)).statusCode).toBe(202);
    expect((await post(envelope(), bearer(), from)).statusCode).toBe(202);
    const limited = await post(envelope(), bearer(), from);

    expect(limited.statusCode).toBe(429);
    expectRetryAfter(limited.headers["retry-after"]);
  });

  describe("detrás de un proxy (trustProxy)", () => {
    const forwarded = (clientIp: string) => ({ ...bearer(UNKNOWN_TOKEN), "x-forwarded-for": clientIp });
    const ALB = { remoteAddress: "10.0.0.5" };

    it("con 1 salto, dos IPs de cliente distintas detrás del mismo balanceador cuentan por separado (401)", async () => {
      const { post } = await makeApp({ trustProxyHops: 1, authFailureLimit: { max: 2, timeWindowMs: 60_000 } });

      expect((await post(envelope(), forwarded("203.0.113.1"), ALB)).statusCode).toBe(401);
      expect((await post(envelope(), forwarded("203.0.113.1"), ALB)).statusCode).toBe(401);
      expect((await post(envelope(), forwarded("203.0.113.1"), ALB)).statusCode).toBe(429);

      expect((await post(envelope(), forwarded("203.0.113.2"), ALB)).statusCode).toBe(401);
    });

    it("con 1 salto, el tope contra floods también cuenta por IP de cliente, no la del balanceador", async () => {
      const { post } = await makeApp({ trustProxyHops: 1, ipRateLimit: { max: 1, timeWindowMs: 60_000 } });
      const valid = (clientIp: string) => ({ ...bearer(), "x-forwarded-for": clientIp });

      expect((await post(envelope(), valid("203.0.113.1"), ALB)).statusCode).toBe(202);
      expect((await post(envelope(), valid("203.0.113.1"), ALB)).statusCode).toBe(429);
      expect((await post(envelope(), valid("203.0.113.2"), ALB)).statusCode).toBe(202);
    });

    it("con 1 salto no se puede falsear la IP: lo que antepone el cliente en X-Forwarded-For se ignora, vale la que añadió el balanceador", async () => {
      const { post } = await makeApp({ trustProxyHops: 1, authFailureLimit: { max: 1, timeWindowMs: 60_000 } });

      expect((await post(envelope(), forwarded("8.8.8.8, 203.0.113.1"), ALB)).statusCode).toBe(401);
      expect((await post(envelope(), forwarded("9.9.9.9, 203.0.113.1"), ALB)).statusCode).toBe(429);
    });

    it("sin trustProxy (0 saltos) X-Forwarded-For se ignora: todo cuenta contra la IP de la conexión", async () => {
      const { post } = await makeApp({ trustProxyHops: 0, authFailureLimit: { max: 1, timeWindowMs: 60_000 } });

      expect((await post(envelope(), forwarded("203.0.113.1"), ALB)).statusCode).toBe(401);
      expect((await post(envelope(), forwarded("203.0.113.2"), ALB)).statusCode).toBe(429);
    });

    it("con 2 saltos se toma el cliente anterior al segundo proxy", async () => {
      const { post } = await makeApp({ trustProxyHops: 2, authFailureLimit: { max: 1, timeWindowMs: 60_000 } });

      expect((await post(envelope(), forwarded("203.0.113.1, 10.1.1.1"), ALB)).statusCode).toBe(401);
      expect((await post(envelope(), forwarded("203.0.113.2, 10.1.1.1"), ALB)).statusCode).toBe(401);
      expect((await post(envelope(), forwarded("203.0.113.1, 10.1.1.1"), ALB)).statusCode).toBe(429);
    });

    it("el límite por dispositivo no depende del proxy: el mismo dispositivo desde dos IPs sigue limitado", async () => {
      const { post } = await makeApp({ trustProxyHops: 1, deviceRateLimit: { max: 1, timeWindowMs: 60_000 } });

      expect((await post(envelope(), { ...bearer(), "x-forwarded-for": "203.0.113.1" }, ALB)).statusCode).toBe(202);
      expect((await post(envelope(), { ...bearer(), "x-forwarded-for": "203.0.113.2" }, ALB)).statusCode).toBe(429);
    });
  });

  it("los 401 no consumen el límite del dispositivo (solo el de la IP)", async () => {
    const { post } = await makeApp({ deviceRateLimit: { max: 1, timeWindowMs: 60_000 } });

    expect((await post(envelope(), bearer("fdt_Zz3Qx9Wm2LpR7vTn4YbHc8DfJ1sAe6UoG0iNhXwVqKE"))).statusCode).toBe(401);
    expect((await post(envelope(), bearer(TOKEN))).statusCode).toBe(202);
  });
});

describe("POST /v1/telemetry/batches: errores del caso de uso", () => {
  it("si no se pudo publicar el lote responde 503 service_unavailable, sin ACK y sin filtrar el error del broker", async () => {
    const { post, logged } = await makeApp({
      receiveBatch: () => Promise.reject(new PublicationFailedError(["telemetry.raw"], new Error("broker 10.0.0.5:9092 caído; lat=6.2518"))),
    });

    const response = await post(envelope());

    expect(response.statusCode).toBe(503);
    expect(errorCode(response.json())).toBe("service_unavailable");
    expectRetryAfter(response.headers["retry-after"]);
    expect(response.json()).not.toHaveProperty("accepted");
    expect(response.body).not.toMatch(/10\.0\.0\.5|broker|6\.2518|telemetry\.raw/);
    expect(logged().some((line) => line.level === "error")).toBe(true);
  });

  it("un error inesperado responde 500 internal_error sin detalles", async () => {
    const { post } = await makeApp({ receiveBatch: () => Promise.reject(new Error("SELECT * FROM telemetry; password authentication failed")) });

    const response = await post(envelope());

    expect(response.statusCode).toBe(500);
    expect(errorCode(response.json())).toBe("internal_error");
    expect(response.body).not.toMatch(/SELECT|password/);
  });

  it("si el directorio de dispositivos no responde (la base cae) responde 503 service_unavailable con Retry-After, nunca 401, 500 ni 202", async () => {
    const { post, received, logged } = await makeApp({
      authenticate: () => Promise.reject(new DeviceDirectoryUnavailableError(Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:5432"), { code: "ECONNREFUSED" }))),
    });

    const response = await post(envelope());

    expect(response.statusCode).toBe(503);
    expect(errorCode(response.json())).toBe("service_unavailable");
    expectRetryAfter(response.headers["retry-after"]);
    expect(response.headers["x-correlation-id"]).toBeDefined();
    expect(response.body).not.toMatch(/10\.0\.0\.5|ECONNREFUSED|5432|postgres/i);
    expect(received).toEqual([]);
    expect(logged().some((line) => line.level === "error")).toBe(true);
  });

  it("un 503 por la base no cuenta como fallo de autenticación de la IP: un dispositivo legítimo no queda bloqueado por una caída", async () => {
    let databaseUp = false;
    const { post } = await makeApp({
      authFailureLimit: { max: 1, timeWindowMs: 60_000 },
      authenticate: (token) =>
        databaseUp ? Promise.resolve(token === TOKEN ? DEVICE : null) : Promise.reject(new DeviceDirectoryUnavailableError(new Error("base caída"))),
    });
    const from = { remoteAddress: "198.51.100.9" };

    for (let i = 0; i < 3; i += 1) expect((await post(envelope(), bearer(), from)).statusCode).toBe(503);
    databaseUp = true;

    expect((await post(envelope(), bearer(), from)).statusCode).toBe(202);
  });

  it("con el tope de consultas de autenticación en vuelo agotado responde 503 con Retry-After (no 401), sin llamar al repositorio interno y sin contar contra la IP", async () => {
    const lookups: string[] = [];
    let release: () => void = () => undefined;
    const inner: DeviceRepository = {
      findActiveByTokenHash(hash) {
        lookups.push(hash);
        return new Promise((resolve) => void (release = () => resolve(DEVICE)));
      },
    };
    const authenticate = createAuthenticateDevice({
      devices: createLimitedDeviceRepository(inner, { maxInFlight: 1 }),
      hashToken: (token) => token,
    });
    const { post } = await makeApp({ authenticate, authFailureLimit: { max: 1, timeWindowMs: 60_000 } });
    const from = { remoteAddress: "198.51.100.9" };

    const occupying = post(envelope(), bearer(TOKEN), from); // ocupa el único cupo
    await vi.waitFor(() => expect(lookups).toHaveLength(1));
    for (let i = 0; i < 3; i += 1) {
      const response = await post(envelope(), bearer(UNKNOWN_TOKEN), from);
      expect(response.statusCode).toBe(503);
      expect(errorCode(response.json())).toBe("service_unavailable");
      expectRetryAfter(response.headers["retry-after"]);
    }
    expect(lookups).toEqual([TOKEN]);

    release();
    expect((await occupying).statusCode).toBe(202);
  });

  it("un error inesperado al autenticar (que no es la base) responde 500 internal_error", async () => {
    const { post, received } = await makeApp({ authenticate: () => Promise.reject(new Error("bug")) });

    const response = await post(envelope());

    expect(response.statusCode).toBe(500);
    expect(errorCode(response.json())).toBe("internal_error");
    expect(received).toEqual([]);
  });
});
