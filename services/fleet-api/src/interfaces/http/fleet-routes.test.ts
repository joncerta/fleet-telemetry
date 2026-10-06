import { randomUUID } from "node:crypto";
import { alertsResponseSchema, apiErrorSchema, fleetSummarySchema, stoppedVehiclesResponseSchema, zoneFeatureCollectionSchema, type Alert } from "@fleet/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ListAlerts } from "../../application/list-alerts.js";
import { NORTE, STOPPED, SUMMARY, SUR, ZONES, makeTestApp, type TestAppOptions } from "../../testing/test-app.js";
import { decodeAlertCursor, encodeAlertCursor } from "./alert-cursor.js";
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

const PATHS = ["/v1/summary", "/v1/vehicles/stopped", "/v1/alerts", "/v1/zones/geojson"] as const;

const alert = (): Alert => ({
  alertId: randomUUID(),
  vehicleId: randomUUID(),
  plate: "ABC123",
  type: "critical_zone_stop",
  zoneId: randomUUID(),
  zoneName: "Zona crítica",
  startedAt: "2026-10-06T10:00:00.000Z",
  raisedAt: "2026-10-06T10:20:00.000Z",
  resolvedAt: null,
  seq: "42",
});

describe("autenticación de las lecturas", () => {
  it.each(PATHS)("%s sin sesión responde 401 y no llega al caso de uso", async (url) => {
    const { app, useCases } = await makeApp();

    const response = await app.inject({ method: "GET", url });

    expect(response.statusCode).toBe(401);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe("unauthorized");
    for (const fn of [useCases.getSummary, useCases.listStoppedVehicles, useCases.listAlerts, useCases.getZonesGeoJson]) expect(fn).not.toHaveBeenCalled();
  });

  it.each(PATHS)("%s con una cookie basura o vencida responde 401", async (url) => {
    const { app, sessionCookieOf } = await makeApp();

    expect((await app.inject({ method: "GET", url, headers: { cookie: "fleet_session=basura" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url, headers: { cookie: sessionCookieOf(NORTE, Math.floor(Date.now() / 1_000) - 5) } })).statusCode).toBe(401);
  });
});

describe("el tenant sale solo de la sesión (regla 4)", () => {
  it("cada lectura recibe el tenantId de la cookie, aunque la petición intente imponer otro por query o header", async () => {
    const { app, useCases, sessionCookieOf } = await makeApp();
    const injected = randomUUID();
    const headers = { cookie: sessionCookieOf(NORTE), "x-tenant-id": injected };

    for (const path of PATHS) await app.inject({ method: "GET", url: `${path}?tenantId=${injected}&tenant_id=${injected}`, headers });

    expect(useCases.getSummary).toHaveBeenCalledExactlyOnceWith({ tenantId: NORTE.tenantId });
    expect(useCases.listStoppedVehicles).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ tenantId: NORTE.tenantId }));
    expect(useCases.listAlerts).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ tenantId: NORTE.tenantId }));
    expect(useCases.getZonesGeoJson).toHaveBeenCalledExactlyOnceWith({ tenantId: NORTE.tenantId });
    expect(JSON.stringify(vi.mocked(useCases.listStoppedVehicles).mock.calls)).not.toContain(injected);
  });

  it("dos sesiones de tenants distintos consultan cada una el suyo", async () => {
    const { app, useCases, sessionCookieOf } = await makeApp();

    await app.inject({ method: "GET", url: "/v1/summary", headers: { cookie: sessionCookieOf(NORTE) } });
    await app.inject({ method: "GET", url: "/v1/summary", headers: { cookie: sessionCookieOf(SUR) } });

    expect(vi.mocked(useCases.getSummary).mock.calls.map(([input]) => input.tenantId)).toEqual([NORTE.tenantId, SUR.tenantId]);
  });
});

describe("GET /v1/summary", () => {
  it("responde 200 con fleetSummarySchema", async () => {
    const { app, sessionCookieOf } = await makeApp();

    const response = await app.inject({ method: "GET", url: "/v1/summary", headers: { cookie: sessionCookieOf(NORTE) } });

    expect(response.statusCode).toBe(200);
    expect(fleetSummarySchema.parse(response.json())).toEqual(SUMMARY);
  });

  it("una respuesta del caso de uso que incumple el contrato se vuelve 500 y no se envía", async () => {
    const { app, sessionCookieOf } = await makeApp({ useCases: { getSummary: () => Promise.resolve({ ...SUMMARY, activeAlerts: -1 }) } });

    const response = await app.inject({ method: "GET", url: "/v1/summary", headers: { cookie: sessionCookieOf(NORTE) } });

    expect(response.statusCode).toBe(500);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe("internal_error");
  });
});

describe("GET /v1/vehicles/stopped", () => {
  const get = (app: FleetApiApp, cookie: string, query = "") => app.inject({ method: "GET", url: `/v1/vehicles/stopped${query}`, headers: { cookie } });

  it("usa los valores por defecto (20 minutos, límite 50, sin filtro de zona)", async () => {
    const { app, useCases, sessionCookieOf } = await makeApp();

    const response = await get(app, sessionCookieOf(NORTE));

    expect(response.statusCode).toBe(200);
    expect(stoppedVehiclesResponseSchema.parse(response.json())).toEqual(STOPPED);
    expect(useCases.listStoppedVehicles).toHaveBeenCalledExactlyOnceWith({ tenantId: NORTE.tenantId, minMinutes: 20, limit: 50, zoneKind: undefined });
  });

  it("convierte minMinutes y limit de texto a número y acepta zoneKind", async () => {
    const { app, useCases, sessionCookieOf } = await makeApp();

    await get(app, sessionCookieOf(NORTE), "?minMinutes=30&zoneKind=critical&limit=10");

    expect(useCases.listStoppedVehicles).toHaveBeenCalledExactlyOnceWith({ tenantId: NORTE.tenantId, minMinutes: 30, limit: 10, zoneKind: "critical" });
  });

  it.each(["minMinutes=0", "minMinutes=1441", "minMinutes=abc", "minMinutes=1.5", "zoneKind=parking", "zoneKind=CRITICAL", "limit=0", "limit=201", "limit=-1"])(
    "rechaza ?%s con 400 sin llegar al caso de uso",
    async (query) => {
      const { app, useCases, sessionCookieOf } = await makeApp();

      const response = await get(app, sessionCookieOf(NORTE), `?${query}`);

      expect(response.statusCode).toBe(400);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe("invalid_request");
      expect(useCases.listStoppedVehicles).not.toHaveBeenCalled();
    },
  );
});

describe("GET /v1/alerts", () => {
  const get = (app: FleetApiApp, cookie: string, query = "") => app.inject({ method: "GET", url: `/v1/alerts${query}`, headers: { cookie } });

  it("por defecto pide las activas, de 50 en 50, y devuelve nextCursor null cuando no hay más", async () => {
    const { app, useCases, sessionCookieOf } = await makeApp();

    const response = await get(app, sessionCookieOf(NORTE));

    expect(response.statusCode).toBe(200);
    expect(alertsResponseSchema.parse(response.json())).toEqual({ items: [], nextCursor: null });
    expect(useCases.listAlerts).toHaveBeenCalledExactlyOnceWith({ tenantId: NORTE.tenantId, status: "active", limit: 50, after: undefined });
  });

  it("emite un cursor OPACO y lo decodifica al recibirlo: la página siguiente continúa desde él, con los microsegundos intactos", async () => {
    const next = { raisedAt: "2026-10-06T10:20:00.123456Z", alertId: randomUUID() };
    const first = alert();
    const listAlerts = vi.fn<ListAlerts>().mockResolvedValueOnce({ items: [first], next }).mockResolvedValueOnce({ items: [], next: null });
    const { app, sessionCookieOf } = await makeApp({ useCases: { listAlerts } });

    const page1 = alertsResponseSchema.parse((await get(app, sessionCookieOf(NORTE), "?status=all&limit=1")).json());
    expect(page1.items).toEqual([first]);
    expect(page1.nextCursor).not.toBeNull();
    expect(page1.nextCursor).not.toContain(next.alertId);
    expect(decodeAlertCursor(page1.nextCursor ?? "")).toEqual(next);

    await get(app, sessionCookieOf(NORTE), `?status=all&limit=1&cursor=${page1.nextCursor}`);

    expect(listAlerts).toHaveBeenLastCalledWith({ tenantId: NORTE.tenantId, status: "all", limit: 1, after: next });
  });

  it.each([
    ["que no es un cursor", "esto-no-es-un-cursor"],
    ["con una inyección SQL", encodeAlertCursor({ raisedAt: "2026-10-06T10:20:00.123456Z", alertId: randomUUID() }).slice(0, 10) + "'%3BDROP%20TABLE%20alerts"],
  ])("un cursor %s responde 400 invalid_cursor sin llegar al caso de uso", async (_label, cursor) => {
    const { app, useCases, sessionCookieOf } = await makeApp();

    const response = await get(app, sessionCookieOf(NORTE), `?cursor=${cursor}`);

    expect(response.statusCode).toBe(400);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe("invalid_cursor");
    expect(useCases.listAlerts).not.toHaveBeenCalled();
  });

  it.each(["status=resolved", "status=", "limit=0", "limit=201", "limit=x", `cursor=${"a".repeat(257)}`])("rechaza ?%s con 400", async (query) => {
    const { app, useCases, sessionCookieOf } = await makeApp();

    expect((await get(app, sessionCookieOf(NORTE), `?${query}`)).statusCode).toBe(400);
    expect(useCases.listAlerts).not.toHaveBeenCalled();
  });
});

describe("GET /v1/zones/geojson", () => {
  it("responde 200 con una FeatureCollection del contrato", async () => {
    const { app, sessionCookieOf } = await makeApp();

    const response = await app.inject({ method: "GET", url: "/v1/zones/geojson", headers: { cookie: sessionCookieOf(NORTE) } });

    expect(response.statusCode).toBe(200);
    expect(zoneFeatureCollectionSchema.parse(response.json())).toEqual(ZONES);
  });
});

describe("las lecturas no filtran datos personales a los logs", () => {
  it("la línea de la petición lleva ruta y estado, y no la query ni la posición ni la placa de la respuesta", async () => {
    const { app, raw, sessionCookieOf } = await makeApp({
      useCases: {
        listStoppedVehicles: () =>
          Promise.resolve({
            serverTime: "2026-10-06T12:00:00.000Z",
            items: [{ vehicleId: randomUUID(), plate: "PLACA-SECRETA", stoppedSince: "2026-10-06T11:00:00.000Z", stoppedMinutes: 60, lon: -75.5636, lat: 6.2518, zone: null }],
          }),
      },
    });

    const response = await app.inject({ method: "GET", url: "/v1/vehicles/stopped?zoneKind=critical", headers: { cookie: sessionCookieOf(NORTE) } });

    expect(response.statusCode).toBe(200);
    for (const forbidden of ["PLACA-SECRETA", "-75.5636", "6.2518", "zoneKind", "fleet_session"]) expect(raw()).not.toContain(forbidden);
  });
});
