import { randomUUID } from "node:crypto";
import { apiErrorSchema, devicePairResponseSchema, pairingCodeSchema } from "@fleet/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InvalidPairingCodeError, VehicleNotFoundError } from "../../application/errors.js";
import type { PairDevice } from "../../application/pair-device.js";
import { NORTE, PAIRED, makeTestApp, type TestAppOptions } from "../../testing/test-app.js";
import type { FleetApiApp } from "./build-app.js";

let current: FleetApiApp | undefined;

afterEach(async () => {
  await current?.close();
  current = undefined;
});

async function makeApp(options: TestAppOptions = {}) {
  const made = await makeTestApp(options);
  current = made.app;
  return made;
}

const vehicleId = randomUUID();
const CODE = "K7M2QX9P";

const createCode = (app: FleetApiApp, payload: unknown, cookie?: string) =>
  app.inject({ method: "POST", url: "/v1/devices/pairing-codes", payload: payload as object, ...(cookie !== undefined && { headers: { cookie } }) });

const pair = (app: FleetApiApp, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: "/v1/devices/pair", payload: payload as object, headers });

describe("POST /v1/devices/pairing-codes", () => {
  it("con sesión responde 201 con pairingCodeSchema, pidiendo el código para la identidad de la sesión", async () => {
    const { app, useCases, sessionCookieOf } = await makeApp();

    const response = await createCode(app, { vehicleId }, sessionCookieOf(NORTE));

    expect(response.statusCode).toBe(201);
    expect(pairingCodeSchema.parse(response.json())).toMatchObject({ code: CODE, vehicleId });
    expect(useCases.createPairingCode).toHaveBeenCalledExactlyOnceWith({ identity: NORTE, vehicleId });
  });

  it("sin sesión responde 401 sin llegar al caso de uso, y la sesión se verifica antes de leer el cuerpo", async () => {
    const { app, useCases } = await makeApp();

    const response = await createCode(app, { vehicleId });

    expect(response.statusCode).toBe(401);
    expect(useCases.createPairingCode).not.toHaveBeenCalled();
  });

  it("ignora un tenantId del cuerpo: la identidad es la de la sesión", async () => {
    const { app, useCases, sessionCookieOf } = await makeApp();

    await createCode(app, { vehicleId, tenantId: randomUUID() }, sessionCookieOf(NORTE));

    expect(useCases.createPairingCode).toHaveBeenCalledExactlyOnceWith({ identity: NORTE, vehicleId });
  });

  it("un vehículo ajeno o inexistente responde 404 not_found", async () => {
    const { app, sessionCookieOf } = await makeApp({ useCases: { createPairingCode: () => Promise.reject(new VehicleNotFoundError()) } });

    const response = await createCode(app, { vehicleId }, sessionCookieOf(NORTE));

    expect(response.statusCode).toBe(404);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe("not_found");
  });

  it.each([{}, { vehicleId: "no-uuid" }, { vehicleId: 7 }])("un cuerpo inválido %j responde 400", async (payload) => {
    const { app, useCases, sessionCookieOf } = await makeApp();

    expect((await createCode(app, payload, sessionCookieOf(NORTE))).statusCode).toBe(400);
    expect(useCases.createPairingCode).not.toHaveBeenCalled();
  });

  it("el código no se registra en los logs, y la respuesta no se cachea", async () => {
    const { app, raw, sessionCookieOf } = await makeApp();

    const response = await createCode(app, { vehicleId }, sessionCookieOf(NORTE));

    expect(raw()).not.toContain(CODE);
    expect(response.headers["cache-control"]).toBe("no-store");
  });
});

describe("POST /v1/devices/pair", () => {
  it("SIN sesión responde 201 con devicePairResponseSchema", async () => {
    const { app, useCases } = await makeApp();

    const response = await pair(app, { code: CODE });

    expect(response.statusCode).toBe(201);
    expect(devicePairResponseSchema.parse(response.json()).deviceToken).toMatch(/^fdt_/);
    expect(useCases.pairDevice).toHaveBeenCalledExactlyOnceWith({ code: CODE });
  });

  it("ni el código ni el token pasan por los logs, y la respuesta no se cachea", async () => {
    const paired = PAIRED(randomUUID());
    const pairDevice = vi.fn<PairDevice>(() => Promise.resolve({ response: paired, tenantId: NORTE.tenantId, deviceId: randomUUID() }));
    const { app, raw } = await makeApp({ useCases: { pairDevice } });

    const response = await pair(app, { code: CODE });

    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(raw()).not.toContain(CODE);
    expect(raw()).not.toContain(paired.deviceToken);
    expect(raw()).not.toContain(paired.plate);
    expect(raw()).toContain("Dispositivo vinculado");
  });

  it("un código inexistente, usado o vencido responde SIEMPRE el mismo 404 genérico", async () => {
    const { app } = await makeApp({ useCases: { pairDevice: () => Promise.reject(new InvalidPairingCodeError()) } });

    const [a, b] = [await pair(app, { code: CODE }), await pair(app, { code: "AAAAAAAA" })];

    expect(a.statusCode).toBe(404);
    expect(apiErrorSchema.parse(a.json())).toEqual({ error: { code: "invalid_pairing_code", message: "El código no es válido o ya venció." } });
    expect(b.json()).toEqual(a.json());
  });

  it.each([{}, { code: "short" }, { code: "k7m2qx9p" }, { code: "K7M2QX9O" }, { code: "K7M2QX90" }, { code: "K7M2QX9PX" }, { code: 12345678 }])(
    "un código con formato inválido %j responde 400 sin llegar al caso de uso",
    async (payload) => {
      const { app, useCases } = await makeApp();

      expect((await pair(app, payload)).statusCode).toBe(400);
      expect(useCases.pairDevice).not.toHaveBeenCalled();
    },
  );

  it("límite estricto por IP: tras N códigos inválidos responde 429 con Retry-After SIN tocar el caso de uso, y otra IP no se ve afectada", async () => {
    const failing = vi.fn<PairDevice>(() => Promise.reject(new InvalidPairingCodeError()));
    const { app } = await makeApp({ useCases: { pairDevice: failing }, pairLimit: { max: 2, timeWindowMs: 60_000 } });
    const attacker = { "x-forwarded-for": "198.51.100.66" };

    expect((await pair(app, { code: "AAAAAAAA" }, attacker)).statusCode).toBe(404);
    expect((await pair(app, { code: "BBBBBBBB" }, attacker)).statusCode).toBe(404);
    const blocked = await pair(app, { code: "CCCCCCCC" }, attacker);

    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect(failing).toHaveBeenCalledTimes(2);
    expect((await pair(app, { code: "DDDDDDDD" }, { "x-forwarded-for": "198.51.100.77" })).statusCode).toBe(404);
  });

  it("un canje correcto no cuenta contra el límite", async () => {
    const { app } = await makeApp({ pairLimit: { max: 1, timeWindowMs: 60_000 } });

    for (let i = 0; i < 4; i++) expect((await pair(app, { code: CODE })).statusCode).toBe(201);
  });

  it("un fallo inesperado de la base responde 500 genérico y no cuenta como código inválido", async () => {
    const { app } = await makeApp({ useCases: { pairDevice: () => Promise.reject(new Error("connect ECONNREFUSED")) }, pairLimit: { max: 1, timeWindowMs: 60_000 } });

    for (let i = 0; i < 3; i++) {
      const response = await pair(app, { code: CODE });
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toMatch(/ECONNREFUSED/);
    }
  });
});
