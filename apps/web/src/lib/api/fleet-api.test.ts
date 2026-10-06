import { describe, expect, it, vi } from "vitest";
import { alert, NOW_ISO, summary, VEHICLE_A } from "../../test-support/fixtures";
import { createFleetApi, FLEET_API_PATHS } from "./fleet-api";
import { ApiRequestError, createHttpClient, InvalidResponseError, NetworkError, UnauthorizedError, type FetchLike } from "./http-client";

const BASE = "http://localhost:4002";

/** Cuerpo JSON enviado (el cliente siempre manda un string). */
const bodyOf = (init: RequestInit | undefined): unknown => (typeof init?.body === "string" ? JSON.parse(init.body) : undefined);

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function setup(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = vi.fn<FetchLike>((url, init) => {
    calls.push({ url, init });
    return Promise.resolve(respond(url, init));
  });
  const logs: { message: string; details: unknown }[] = [];
  const onUnauthorized = vi.fn();
  const http = createHttpClient({ baseUrl: BASE, fetch, logError: (message, details) => logs.push({ message, details }) });
  const api = createFleetApi(http, onUnauthorized);
  return { api, calls, logs, onUnauthorized };
}

const session = {
  user: { userId: "0f9a7c1e-0000-4000-8000-000000000001", email: "operador@norte.test", name: "Operador Norte" },
  tenant: { tenantId: "f1ee7000-0000-4000-8000-000000000001", name: "Flota Norte" },
};

describe("fleet-api", () => {
  it("envía la cookie (credentials: include), sin caché, a la URL de la API", async () => {
    const { api, calls } = setup(() => json(200, summary()));
    await expect(api.getSummary()).resolves.toEqual(summary());

    expect(calls[0]?.url).toBe(`${BASE}${FLEET_API_PATHS.summary}`);
    expect(calls[0]?.init).toMatchObject({ method: "GET", credentials: "include", cache: "no-store" });
  });

  it("el login manda el cuerpo como JSON y devuelve la sesión", async () => {
    const { api, calls } = setup(() => json(200, session));
    await expect(api.login({ email: "operador@norte.test", password: "secreta-de-prueba" })).resolves.toEqual(session);
    expect(calls[0]?.url).toBe(`${BASE}${FLEET_API_PATHS.login}`);
    expect(calls[0]?.init).toMatchObject({ method: "POST", headers: { "content-type": "application/json" } });
    expect(bodyOf(calls[0]?.init)).toEqual({ email: "operador@norte.test", password: "secreta-de-prueba" });
  });

  it("un 401 de una lectura con sesión lanza UnauthorizedError y lleva a 'sin sesión'", async () => {
    const { api, onUnauthorized } = setup(() => json(401, { error: { code: "unauthorized", message: "Sesión ausente." } }));
    await expect(api.getSummary()).rejects.toBeInstanceOf(UnauthorizedError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("un 401 del login son credenciales inválidas: NO avisa de sesión vencida", async () => {
    const { api, onUnauthorized } = setup(() => json(401, { error: { code: "invalid_credentials", message: "x" } }));
    await expect(api.login({ email: "a@b.co", password: "x" })).rejects.toBeInstanceOf(UnauthorizedError);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("un error con apiErrorSchema conserva código, mensaje y Retry-After", async () => {
    const { api } = setup(() => json(429, { error: { code: "rate_limited", message: "Demasiadas solicitudes." } }, { "retry-after": "90" }));
    const error: unknown = await api.getSummary().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ status: 429, code: "rate_limited", message: "Demasiadas solicitudes.", retryAfterSeconds: 90 });
  });

  it("un error sin cuerpo del contrato (un proxy) se reporta por su estado", async () => {
    const { api } = setup(() => new Response("<html>502</html>", { status: 502 }));
    await expect(api.getSummary()).rejects.toMatchObject({ status: 502, code: "http_502" });
  });

  it("sin respuesta (API caída o CORS) es NetworkError", async () => {
    const { api } = setup(() => Promise.reject(new TypeError("Failed to fetch")));
    await expect(api.getSummary()).rejects.toBeInstanceOf(NetworkError);
  });

  it("una cancelación se propaga tal cual (no es un error de red)", async () => {
    const { api } = setup(() => Promise.reject(new DOMException("aborted", "AbortError")));
    await expect(api.getSummary()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("una respuesta que no cumple el contrato se descarta y se registra sin sus valores", async () => {
    const { api, logs } = setup(() => json(200, { ...summary(), vehicles: { total: "NRT101" } }));
    await expect(api.getSummary()).rejects.toBeInstanceOf(InvalidResponseError);
    expect(JSON.stringify(logs)).toContain("vehicles.total");
    expect(JSON.stringify(logs)).not.toContain("NRT101");
  });

  it("lee con las variantes tolerantes: un tipo de alerta nuevo llega como 'unknown'", async () => {
    const { api, calls } = setup(() => json(200, { items: [{ ...alert(), type: "harsh_braking" }], nextCursor: null }));
    const page = await api.getAlerts({ status: "all", limit: 50 });
    expect(page.items[0]?.type).toBe("unknown");
    expect(calls[0]?.url).toBe(`${BASE}/v1/alerts?status=all&limit=50`);
  });

  it("arma la querystring de los detenidos", async () => {
    const { api, calls } = setup(() => json(200, { serverTime: NOW_ISO, items: [] }));
    await api.getStoppedVehicles({ minMinutes: 20, zoneKind: "critical", limit: 50 });
    expect(calls[0]?.url).toBe(`${BASE}/v1/vehicles/stopped?minMinutes=20&limit=50&zoneKind=critical`);
  });

  it("el código de vinculación solo envía el vehicleId (nunca tenantId) y acepta el 201", async () => {
    const code = { code: "ABCD2345", vehicleId: VEHICLE_A, expiresAt: NOW_ISO };
    const { api, calls } = setup(() => json(201, code));
    await expect(api.createPairingCode(VEHICLE_A)).resolves.toEqual(code);
    expect(calls[0]?.url).toBe(`${BASE}/v1/devices/pairing-codes`);
    expect(bodyOf(calls[0]?.init)).toEqual({ vehicleId: VEHICLE_A });
  });

  it("el catálogo pide el límite, valida la respuesta y un 401 lleva al login", async () => {
    const item = { vehicleId: VEHICLE_A, plate: "NRT101", label: null, hasActiveDevice: false, createdAt: NOW_ISO };
    const ok = setup(() => json(200, { items: [item], limit: 500 }));
    await expect(ok.api.listVehicles(500)).resolves.toEqual({ items: [item], limit: 500 });
    expect(ok.calls[0]?.url).toBe(`${BASE}/v1/vehicles?limit=500`);

    const invalid = setup(() => json(200, { items: [{ ...item, vehicleId: "no-es-uuid" }], limit: 500 }));
    await expect(invalid.api.listVehicles(500)).rejects.toBeInstanceOf(InvalidResponseError);

    const unauthorized = setup(() => json(401, { error: { code: "unauthorized", message: "x" } }));
    await expect(unauthorized.api.listVehicles(500)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(unauthorized.onUnauthorized).toHaveBeenCalledOnce();
  });

  it("el alta envía solo placa y nombre (nunca tenantId), acepta el 201 y propaga el 409", async () => {
    const created = { vehicleId: VEHICLE_A, plate: "ABC123", label: "Camión", hasActiveDevice: false, createdAt: NOW_ISO };
    const ok = setup(() => json(201, created));
    await expect(ok.api.createVehicle({ plate: "ABC123", label: "Camión" })).resolves.toEqual(created);
    expect(ok.calls[0]?.url).toBe(`${BASE}/v1/vehicles`);
    expect(ok.calls[0]?.init.method).toBe("POST");
    expect(bodyOf(ok.calls[0]?.init)).toEqual({ plate: "ABC123", label: "Camión" });

    const taken = setup(() => json(409, { error: { code: "plate_taken", message: "x" } }));
    await expect(taken.api.createVehicle({ plate: "ABC123", label: null })).rejects.toMatchObject({ status: 409, code: "plate_taken" });
  });

  it("los usuarios se piden con límite y se validan", async () => {
    const user = { userId: VEHICLE_A, name: "Operador Norte", email: "operador@norte.test", createdAt: NOW_ISO };
    const { api, calls } = setup(() => json(200, { items: [user] }));
    await expect(api.listUsers(100)).resolves.toEqual({ items: [user] });
    expect(calls[0]?.url).toBe(`${BASE}/v1/users?limit=100`);
  });

  it("una respuesta de usuarios que no cumple el contrato se descarta (InvalidResponseError) sin loguear sus valores", async () => {
    const bad = { userId: "no-es-uuid", name: "Operador Norte", email: "operador@norte.test", createdAt: NOW_ISO };
    const { api, logs } = setup(() => json(200, { items: [bad] }));
    await expect(api.listUsers(100)).rejects.toBeInstanceOf(InvalidResponseError);
    const logged = JSON.stringify(logs);
    expect(logged).not.toContain("operador@norte.test");
    expect(logged).not.toContain("Operador Norte");
  });

  it("el logout acepta el 204 sin cuerpo", async () => {
    const { api } = setup(() => new Response(null, { status: 204 }));
    await expect(api.logout()).resolves.toBeUndefined();
  });
});
