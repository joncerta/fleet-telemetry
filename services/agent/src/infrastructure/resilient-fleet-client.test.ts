import { createLogger } from "@fleet/platform";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FleetData } from "../application/ports.js";
import { ALERTS, CONTEXT, STOPPED, SUMMARY } from "../testing/fakes.js";
import { createResilientFleetClient, type ResilientFleetClient } from "./resilient-fleet-client.js";

const SETTINGS = { timeoutMs: 500, errorThresholdPercentage: 50, volumeThreshold: 3, resetTimeoutMs: 1_000, rollingWindowMs: 10_000 };
const BASE_URL = "http://fleet-api.test:4002";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Texto de la URL con la que se llamó a `fetch`. */
const urlOf = (input: Parameters<typeof fetch>[0] | undefined): string => (input instanceof URL ? input.href : typeof input === "string" ? input : (input?.url ?? ""));

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

const clients: ResilientFleetClient[] = [];

function makeClient(fetchImpl: FetchMock): ResilientFleetClient {
  const client = createResilientFleetClient({ baseUrl: BASE_URL, breaker: SETTINGS, fetch: fetchImpl });
  clients.push(client);
  return client;
}

/** Una consulta cualquiera: la más simple, sin parámetros. */
const summary = (client: FleetData) => client.fleetSummary(CONTEXT);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const client of clients.splice(0)) client.shutdown();
  vi.useRealTimers();
});

describe("llamadas a fleet-api", () => {
  it("reenvía SOLO la cookie de sesión del usuario y el correlationId, con GET", async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(json(SUMMARY)));
    const client = makeClient(fetchMock);

    const result = await summary(client);

    expect(result).toEqual({ kind: "ok", data: SUMMARY });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(urlOf(url)).toBe(`${BASE_URL}/v1/summary`);
    expect(init?.method).toBe("GET");
    expect(init?.headers).toEqual({ accept: "application/json", cookie: `fleet_session=${CONTEXT.sessionToken}`, "x-correlation-id": CONTEXT.correlationId });
    expect(init?.redirect).toBe("error");
  });

  it("no manda el tenant ni el usuario en la URL ni en la query: solo la sesión los lleva", async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(json(STOPPED)));
    const client = makeClient(fetchMock);

    await client.stoppedVehicles(CONTEXT, { minMinutes: 20, zoneKind: "critical", limit: 20 });

    const url = urlOf(fetchMock.mock.calls[0]?.[0]);
    expect(url).toBe(`${BASE_URL}/v1/vehicles/stopped?minMinutes=20&limit=20&zoneKind=critical`);
    expect(url).not.toContain(CONTEXT.identity.tenantId);
    expect(url).not.toContain(CONTEXT.identity.userId);
  });

  it("stoppedVehicles sin zoneKind no lo manda; activeAlerts pide status=active con su límite", async () => {
    const fetchMock = vi.fn<typeof fetch>((input) => Promise.resolve(urlOf(input).includes("/alerts") ? json(ALERTS) : json(STOPPED)));
    const client = makeClient(fetchMock);

    await client.stoppedVehicles(CONTEXT, { minMinutes: 30, limit: 5 });
    const alerts = await client.activeAlerts(CONTEXT, { limit: 7 });

    expect(urlOf(fetchMock.mock.calls[0]?.[0])).toBe(`${BASE_URL}/v1/vehicles/stopped?minMinutes=30&limit=5`);
    expect(urlOf(fetchMock.mock.calls[1]?.[0])).toBe(`${BASE_URL}/v1/alerts?status=active&limit=7`);
    expect(alerts.kind).toBe("ok");
  });

  it("parsea con los esquemas tolerantes: un tipo de zona desconocido se lee como unknown en vez de fallar", async () => {
    const futuristic = { ...STOPPED, items: [{ ...STOPPED.items[0], zone: { ...STOPPED.items[0]?.zone, kind: "airport" } }] };
    const client = makeClient(vi.fn<typeof fetch>(() => Promise.resolve(json(futuristic))));

    const result = await client.stoppedVehicles(CONTEXT, { minMinutes: 20, limit: 20 });

    expect(result.kind).toBe("ok");
    expect(result.kind === "ok" ? result.data.items[0]?.zone?.kind : undefined).toBe("unknown");
  });

  it("una respuesta con estructura inesperada es unavailable (invalid_response), nunca datos a medias, y no abre el circuito", async () => {
    const client = makeClient(vi.fn<typeof fetch>(() => Promise.resolve(json({ otra: "cosa" }))));

    for (let i = 0; i < 5; i++) expect(await summary(client)).toEqual({ kind: "unavailable", reason: "invalid_response" });

    expect(client.breakerState()).toBe("closed");
  });
});

describe("circuit breaker", () => {
  it("abre con fallos 5xx: tras el umbral, las llamadas siguientes no llegan a fleet-api y devuelven el fallback marcado", async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(json({ error: "x" }, 503)));
    const client = makeClient(fetchMock);

    for (let i = 0; i < SETTINGS.volumeThreshold; i++) expect(await summary(client)).toEqual({ kind: "unavailable", reason: "upstream_error" });
    expect(client.breakerState()).toBe("open");

    const calls = fetchMock.mock.calls.length;
    const fallback = await summary(client);

    expect(fallback).toEqual({ kind: "unavailable", reason: "breaker_open" });
    expect(fetchMock).toHaveBeenCalledTimes(calls);
    // El fallback NO se hace pasar por datos reales.
    expect(fallback).not.toHaveProperty("data");
  });

  it("abre con timeouts: una llamada que no responde cuenta como fallo (reason timeout)", async () => {
    const fetchMock = vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined));
    const client = makeClient(fetchMock);

    for (let i = 0; i < SETTINGS.volumeThreshold; i++) {
      const pending = summary(client);
      await vi.advanceTimersByTimeAsync(SETTINGS.timeoutMs + 1);
      expect(await pending).toEqual({ kind: "unavailable", reason: "timeout" });
    }

    expect(client.breakerState()).toBe("open");
    expect(await summary(client)).toEqual({ kind: "unavailable", reason: "breaker_open" });
  });

  it("abre con errores de red (fleet-api caído)", async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.reject(new TypeError("fetch failed")));
    const client = makeClient(fetchMock);

    for (let i = 0; i < SETTINGS.volumeThreshold; i++) expect(await summary(client)).toEqual({ kind: "unavailable", reason: "upstream_error" });

    expect(client.breakerState()).toBe("open");
  });

  it("NO abre con 4xx: fleet-api respondió, así que se devuelve rejected con el estado y el circuito sigue cerrado", async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(json({ error: { code: "unauthorized", message: "x" } }, 401)));
    const client = makeClient(fetchMock);

    for (let i = 0; i < SETTINGS.volumeThreshold * 4; i++) expect(await summary(client)).toEqual({ kind: "rejected", status: 401 });

    expect(client.breakerState()).toBe("closed");
    expect(fetchMock).toHaveBeenCalledTimes(SETTINGS.volumeThreshold * 4);
  });

  it("los 4xx no ayudan a abrir: mezclados con pocos 5xx, el porcentaje de fallos no alcanza el umbral", async () => {
    let call = 0;
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(++call % 4 === 0 ? json({}, 500) : json({}, 404)));
    const client = makeClient(fetchMock);

    for (let i = 0; i < 8; i++) await summary(client);

    expect(client.breakerState()).toBe("closed");
  });

  it("pasa a halfOpen tras resetTimeout y un éxito lo cierra", async () => {
    let healthy = false;
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(healthy ? json(SUMMARY) : json({}, 500)));
    const client = makeClient(fetchMock);
    for (let i = 0; i < SETTINGS.volumeThreshold; i++) await summary(client);
    expect(client.breakerState()).toBe("open");

    await vi.advanceTimersByTimeAsync(SETTINGS.resetTimeoutMs + 1);
    expect(client.breakerState()).toBe("halfOpen");

    healthy = true;
    const probe = await summary(client);

    expect(probe).toEqual({ kind: "ok", data: SUMMARY });
    expect(client.breakerState()).toBe("closed");
  });

  it("si la prueba en halfOpen falla, vuelve a abrir", async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(json({}, 500)));
    const client = makeClient(fetchMock);
    for (let i = 0; i < SETTINGS.volumeThreshold; i++) await summary(client);
    await vi.advanceTimersByTimeAsync(SETTINGS.resetTimeoutMs + 1);
    expect(client.breakerState()).toBe("halfOpen");

    expect(await summary(client)).toEqual({ kind: "unavailable", reason: "upstream_error" });

    expect(client.breakerState()).toBe("open");
  });

  it("el breaker es uno por cliente y se comparte entre llamadas: los fallos de distintas consultas se acumulan", async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(json({}, 500)));
    const client = makeClient(fetchMock);

    await client.fleetSummary(CONTEXT);
    await client.activeAlerts(CONTEXT, { limit: 5 });
    await client.stoppedVehicles(CONTEXT, { minMinutes: 20, limit: 5 });

    expect(client.breakerState()).toBe("open");
    // Otro cliente tiene su propio circuito.
    expect(makeClient(vi.fn<typeof fetch>(() => Promise.resolve(json(SUMMARY)))).breakerState()).toBe("closed");
  });

  it("no abre antes del volumen mínimo: dos fallos con umbral 3 siguen cerrados", async () => {
    const client = makeClient(vi.fn<typeof fetch>(() => Promise.resolve(json({}, 500))));

    await summary(client);
    await summary(client);

    expect(client.breakerState()).toBe("closed");
  });

  it("registra cada fallo con su motivo y los cambios de estado del circuito, sin el mensaje del error", async () => {
    const lines: string[] = [];
    const logger = createLogger({ service: "agent-test", level: "info", destination: { write: (line: string) => void lines.push(line) } });
    const fetchMock = vi.fn<typeof fetch>(() => Promise.reject(new TypeError("fetch failed: ECONNREFUSED 10.0.0.7 con datos internos")));
    const client = createResilientFleetClient({ baseUrl: BASE_URL, breaker: SETTINGS, fetch: fetchMock, logger });
    clients.push(client);

    for (let i = 0; i < SETTINGS.volumeThreshold; i++) await summary(client);
    await vi.advanceTimersByTimeAsync(SETTINGS.resetTimeoutMs + 1);

    const messages = lines.map((line) => JSON.parse(line) as { msg: string; reason?: string });
    expect(messages.filter((entry) => entry.msg === "Llamada a fleet-api fallida")).toHaveLength(SETTINGS.volumeThreshold);
    expect(messages.find((entry) => entry.msg === "Llamada a fleet-api fallida")?.reason).toBe("upstream_error");
    expect(messages.map((entry) => entry.msg)).toEqual(expect.arrayContaining(["Circuit breaker abierto", "Circuit breaker en halfOpen"]));
    expect(lines.join("")).not.toMatch(/ECONNREFUSED|10.0.0.7|datos internos/);
  });

  it("no hay reintentos: un fallo es una sola llamada a fleet-api", async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(json({}, 500)));
    const client = makeClient(fetchMock);

    await summary(client);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
