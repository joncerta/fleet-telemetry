import { randomUUID } from "node:crypto";
import { apiErrorSchema, userListResponseSchema, vehicleCatalogItemSchema, vehicleListResponseSchema } from "@fleet/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { PlateTakenError } from "../../application/errors.js";
import { CATALOG_VEHICLE, makeTestApp, NORTE, type TestAppOptions } from "../../testing/test-app.js";
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

const post = (app: FleetApiApp, payload: unknown, cookie?: string) =>
  app.inject({ method: "POST", url: "/v1/vehicles", payload: payload as object, ...(cookie !== undefined && { headers: { cookie } }) });
const get = (app: FleetApiApp, url: string, cookie?: string) => app.inject({ method: "GET", url, ...(cookie !== undefined && { headers: { cookie } }) });

describe("GET /v1/vehicles", () => {
  it("con sesión responde 200 con vehicleListResponseSchema, pidiendo el catálogo del tenant de la SESIÓN con el limit por defecto (200)", async () => {
    const { app, useCases, sessionCookieOf } = await makeApp();

    const response = await get(app, "/v1/vehicles", sessionCookieOf(NORTE));

    expect(response.statusCode).toBe(200);
    expect(vehicleListResponseSchema.parse(response.json())).toEqual({ items: [CATALOG_VEHICLE], limit: 200 });
    expect(useCases.listVehicles).toHaveBeenCalledExactlyOnceWith({ tenantId: NORTE.tenantId, limit: 200 });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("ignora un tenantId de la query: el tenant es el de la sesión", async () => {
    const { app, useCases, sessionCookieOf } = await makeApp();

    await get(app, `/v1/vehicles?limit=5&tenantId=${randomUUID()}`, sessionCookieOf(NORTE));

    expect(useCases.listVehicles).toHaveBeenCalledExactlyOnceWith({ tenantId: NORTE.tenantId, limit: 5 });
  });

  it.each(["0", "501", "abc", "1.5"])("un limit inválido (%s) responde 400 sin llegar al caso de uso", async (limit) => {
    const { app, useCases, sessionCookieOf } = await makeApp();

    expect((await get(app, `/v1/vehicles?limit=${limit}`, sessionCookieOf(NORTE))).statusCode).toBe(400);
    expect(useCases.listVehicles).not.toHaveBeenCalled();
  });

  it("sin sesión responde 401 y la ruta estática /v1/vehicles/stopped sigue siendo otra", async () => {
    const { app, useCases, sessionCookieOf } = await makeApp();

    expect((await get(app, "/v1/vehicles")).statusCode).toBe(401);
    expect(useCases.listVehicles).not.toHaveBeenCalled();
    expect((await get(app, "/v1/vehicles/stopped", sessionCookieOf(NORTE))).statusCode).toBe(200);
  });
});

describe("POST /v1/vehicles", () => {
  it("con sesión responde 201 con el vehículo, creándolo para la identidad de la sesión con la placa normalizada", async () => {
    const { app, useCases, sessionCookieOf } = await makeApp();

    const response = await post(app, { plate: " abc-123 ", label: "  Camión 7  " }, sessionCookieOf(NORTE));

    expect(response.statusCode).toBe(201);
    expect(vehicleCatalogItemSchema.parse(response.json())).toEqual(CATALOG_VEHICLE);
    expect(useCases.createVehicle).toHaveBeenCalledExactlyOnceWith({ identity: NORTE, vehicle: { plate: "ABC-123", label: "Camión 7" } });
  });

  it("sin etiqueta la guarda como null", async () => {
    const { app, useCases, sessionCookieOf } = await makeApp();

    await post(app, { plate: "abc123" }, sessionCookieOf(NORTE));

    expect(useCases.createVehicle).toHaveBeenCalledExactlyOnceWith({ identity: NORTE, vehicle: { plate: "ABC123", label: null } });
  });

  it("ignora un tenantId o un vehicleId del cuerpo: la identidad es la de la sesión y el id lo decide el servidor", async () => {
    const { app, useCases, sessionCookieOf } = await makeApp();

    await post(app, { plate: "ABC123", tenantId: randomUUID(), vehicleId: randomUUID() }, sessionCookieOf(NORTE));

    expect(useCases.createVehicle).toHaveBeenCalledExactlyOnceWith({ identity: NORTE, vehicle: { plate: "ABC123", label: null } });
  });

  it("sin sesión responde 401 sin llegar al caso de uso", async () => {
    const { app, useCases } = await makeApp();

    expect((await post(app, { plate: "ABC123" })).statusCode).toBe(401);
    expect(useCases.createVehicle).not.toHaveBeenCalled();
  });

  it("una placa repetida responde 409 plate_taken, sin la placa en la respuesta ni en los logs", async () => {
    const { app, raw, sessionCookieOf } = await makeApp({ useCases: { createVehicle: () => Promise.reject(new PlateTakenError()) } });

    const response = await post(app, { plate: "ZZZ999" }, sessionCookieOf(NORTE));

    expect(response.statusCode).toBe(409);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe("plate_taken");
    expect(response.body).not.toContain("ZZZ999");
    expect(raw()).not.toContain("ZZZ999");
  });

  it.each([{}, { plate: "" }, { plate: "AB CD" }, { plate: "A".repeat(33) }, { plate: 7 }, { plate: "ABC123", label: "a".repeat(65) }, { plate: "ABC123", label: 5 }])(
    "un cuerpo inválido %j responde 400 sin llegar al caso de uso",
    async (payload) => {
      const { app, useCases, sessionCookieOf } = await makeApp();

      const response = await post(app, payload, sessionCookieOf(NORTE));

      expect(response.statusCode).toBe(400);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe("invalid_request");
      expect(useCases.createVehicle).not.toHaveBeenCalled();
    },
  );

  it("solo acepta application/json: text/plain responde 415", async () => {
    const { app, useCases, sessionCookieOf } = await makeApp();

    const response = await app.inject({
      method: "POST",
      url: "/v1/vehicles",
      payload: '{"plate":"ABC123"}',
      headers: { cookie: sessionCookieOf(NORTE), "content-type": "text/plain" },
    });

    expect(response.statusCode).toBe(415);
    expect(useCases.createVehicle).not.toHaveBeenCalled();
  });

  it("ni la placa ni el alias pasan por los logs; la línea lleva solo identificadores", async () => {
    const { app, raw, sessionCookieOf } = await makeApp();

    await post(app, { plate: "QWE987", label: "Alias Secreto" }, sessionCookieOf(NORTE));

    expect(raw()).not.toContain("QWE987");
    expect(raw()).not.toContain("Alias Secreto");
    expect(raw()).not.toContain(CATALOG_VEHICLE.plate);
    expect(raw()).toContain("Vehículo creado");
  });

  it("el límite de altas es por usuario: al superarlo, 429 con Retry-After, y otro usuario no se ve afectado", async () => {
    const { app, useCases, sessionCookieOf } = await makeApp({ createVehicleLimit: { max: 2, timeWindowMs: 60_000 } });
    const other = { userId: randomUUID(), tenantId: randomUUID() };

    expect((await post(app, { plate: "AAA111" }, sessionCookieOf(NORTE))).statusCode).toBe(201);
    expect((await post(app, { plate: "AAA112" }, sessionCookieOf(NORTE))).statusCode).toBe(201);
    const blocked = await post(app, { plate: "AAA113" }, sessionCookieOf(NORTE));

    expect(blocked.statusCode).toBe(429);
    expect(apiErrorSchema.parse(blocked.json()).error.code).toBe("rate_limited");
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect(useCases.createVehicle).toHaveBeenCalledTimes(2);
    expect((await post(app, { plate: "BBB111" }, sessionCookieOf(other))).statusCode).toBe(201);
  });
});

describe("GET /v1/users", () => {
  it("con sesión responde 200 con userListResponseSchema para el tenant de la SESIÓN, con el limit por defecto (100)", async () => {
    const user = { userId: randomUUID(), name: "Operador Norte", email: "operador@norte.test", createdAt: "2026-10-06T12:00:00.000Z" };
    const { app, sessionCookieOf } = await makeApp({ useCases: { listUsers: () => Promise.resolve({ items: [user] }) } });

    const response = await get(app, "/v1/users", sessionCookieOf(NORTE));

    expect(response.statusCode).toBe(200);
    expect(userListResponseSchema.parse(response.json())).toEqual({ items: [user] });
  });

  it("pasa el tenant de la sesión y el limit (por defecto 100), e ignora un tenantId de la query", async () => {
    const { app, useCases, sessionCookieOf } = await makeApp();

    await get(app, "/v1/users", sessionCookieOf(NORTE));
    await get(app, `/v1/users?limit=7&tenantId=${randomUUID()}`, sessionCookieOf(NORTE));

    expect(useCases.listUsers).toHaveBeenNthCalledWith(1, { tenantId: NORTE.tenantId, limit: 100 });
    expect(useCases.listUsers).toHaveBeenNthCalledWith(2, { tenantId: NORTE.tenantId, limit: 7 });
  });

  it("el hash de la contraseña no sale aunque el caso de uso lo devolviera: la respuesta se serializa con el esquema", async () => {
    const leaky = { userId: randomUUID(), name: "Op", email: "op@norte.test", createdAt: "2026-10-06T12:00:00.000Z", passwordHash: "scrypt$secreto" };
    const { app, sessionCookieOf } = await makeApp({ useCases: { listUsers: () => Promise.resolve({ items: [leaky] }) } });

    const response = await get(app, "/v1/users", sessionCookieOf(NORTE));

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("scrypt$secreto");
  });

  it.each(["0", "501"])("un limit inválido (%s) responde 400", async (limit) => {
    const { app, sessionCookieOf } = await makeApp();

    expect((await get(app, `/v1/users?limit=${limit}`, sessionCookieOf(NORTE))).statusCode).toBe(400);
  });

  it("sin sesión responde 401", async () => {
    const { app, useCases } = await makeApp();

    expect((await get(app, "/v1/users")).statusCode).toBe(401);
    expect(useCases.listUsers).not.toHaveBeenCalled();
  });
});
