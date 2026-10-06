import { randomUUID } from "node:crypto";
import { apiErrorSchema, sseAlertSchema, sseSnapshotSchema, sseVehicleStateSchema, SSE_HEARTBEAT_COMMENT, type Alert, type VehicleState } from "@fleet/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenFleetStream } from "../../application/open-fleet-stream.js";
import type { FleetSnapshotReader } from "../../application/ports.js";
import { openSse, type SseConnection } from "../../testing/sse-client.js";
import { ALLOWED_ORIGIN, NORTE, STREAM_VEHICLE, SUR, makeTestApp, type TestAppOptions } from "../../testing/test-app.js";
import type { FleetApiApp } from "./build-app.js";

// Las rutas se prueban contra un servidor REAL (puerto efímero) y un cliente `fetch` que lee el stream: `app.inject` no sirve con `hijack()`.
let current: FleetApiApp | undefined;
const connections: SseConnection[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const connection of connections.splice(0)) connection.close();
  await current?.close();
  current = undefined;
});

async function makeApp(options: TestAppOptions = {}) {
  const made = await makeTestApp(options);
  current = made.app;
  await made.app.listen({ host: "127.0.0.1", port: 0 });
  const address = made.app.server.address();
  if (address === null || typeof address === "string") throw new Error("el servidor no escucha en un puerto");
  const url = `http://127.0.0.1:${address.port}/v1/stream`;
  const connect = async (headers: Record<string, string>) => {
    const connection = await openSse(url, headers);
    connections.push(connection);
    return connection;
  };
  return { ...made, url, connect };
}

const vehicleAt = (seq: string, overrides: Partial<VehicleState> = {}): VehicleState => ({ ...STREAM_VEHICLE, seq, ...overrides });
const alertAt = (seq: string): Alert => ({
  alertId: randomUUID(),
  vehicleId: STREAM_VEHICLE.vehicleId,
  plate: STREAM_VEHICLE.plate,
  type: "critical_zone_stop",
  zoneId: null,
  zoneName: null,
  startedAt: "2026-10-06T11:30:00.000Z",
  raisedAt: "2026-10-06T11:50:00.000Z",
  resolvedAt: null,
  seq,
});

/** Espera por sondeo, nunca con un sleep fijo. */
async function waitFor(what: string, probe: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`Se agotaron ${timeoutMs} ms esperando: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("autenticación", () => {
  it("sin cookie responde 401 con apiErrorSchema y no llega al caso de uso", async () => {
    const openFleetStream = vi.fn<OpenFleetStream["open"]>();
    const { app } = await makeApp({ useCases: { openFleetStream } });

    const response = await app.inject({ method: "GET", url: "/v1/stream" });

    expect(response.statusCode).toBe(401);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe("unauthorized");
    expect(openFleetStream).not.toHaveBeenCalled();
  });

  it("con una cookie basura o vencida responde 401, y un token en la URL no sustituye a la cookie", async () => {
    const { app, sessionCookieOf } = await makeApp();

    expect((await app.inject({ method: "GET", url: "/v1/stream", headers: { cookie: "fleet_session=basura" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/v1/stream", headers: { cookie: sessionCookieOf(NORTE, Math.floor(Date.now() / 1_000) - 5) } })).statusCode).toBe(401);
    const token = sessionCookieOf(NORTE).split("=")[1] ?? "";
    expect((await app.inject({ method: "GET", url: `/v1/stream?token=${token}&access_token=${token}` })).statusCode).toBe(401);
  });
});

describe("el tenant sale solo de la sesión (regla 4)", () => {
  it("el snapshot se lee con el tenantId de la cookie, aunque la petición intente imponer otro por query o header", async () => {
    const read = vi.fn<FleetSnapshotReader["read"]>(() => Promise.resolve({ vehicles: [], alerts: [] }));
    const { url, sessionCookieOf, connect } = await makeApp({ snapshots: { read } });
    const injected = randomUUID();

    const stream = await connect({ cookie: sessionCookieOf(NORTE), "x-tenant-id": injected });
    await stream.next();
    const withQuery = await openSse(`${url}?tenantId=${injected}&tenant_id=${injected}`, { cookie: sessionCookieOf(NORTE) });
    connections.push(withQuery);
    await withQuery.next();

    expect(read).toHaveBeenCalledTimes(2);
    for (const [tenantId] of read.mock.calls) expect(tenantId).toBe(NORTE.tenantId);
    expect(JSON.stringify(read.mock.calls)).not.toContain(injected);
  });

  it("el stream de Sur no recibe los eventos de Norte y viceversa", async () => {
    const { hub, sessionCookieOf, connect } = await makeApp();
    const norte = await connect({ cookie: sessionCookieOf(NORTE) });
    const sur = await connect({ cookie: sessionCookieOf(SUR) });
    await norte.next();
    await sur.next();

    hub.publish(NORTE.tenantId, { type: "vehicle.state", state: vehicleAt("20") });
    hub.publish(SUR.tenantId, { type: "alert", alert: alertAt("21") });

    expect(await norte.next()).toMatchObject({ event: "vehicle.state", id: "20" });
    expect(await sur.next()).toMatchObject({ event: "alert", id: "21" });
    // Nada más: el siguiente bloque de cada uno tendría que ser un latido (que no llega en este tiempo) y no un evento ajeno.
    await expect(norte.next(150)).rejects.toThrow(/Se agotaron/);
    await expect(sur.next(150)).rejects.toThrow(/Se agotaron/);
  });
});

describe("cabeceras de la respuesta (tras hijack)", () => {
  it("es text/event-stream sin caché ni buffering de proxy y con el correlationId de la petición", async () => {
    const { sessionCookieOf, connect } = await makeApp();

    const stream = await connect({ cookie: sessionCookieOf(NORTE), "x-correlation-id": "corr-sse-1" });

    const { headers, status } = stream.response;
    expect(status).toBe(200);
    expect(headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    // Sobrescribe el `no-store` global: un stream no se cachea pero tampoco necesita `no-store`, y los proxies leen `no-cache`.
    expect(headers.get("cache-control")).toBe("no-cache");
    expect(headers.get("connection")).toBe("keep-alive");
    expect(headers.get("x-accel-buffering")).toBe("no");
    expect(headers.get("x-correlation-id")).toBe("corr-sse-1");
  });

  it("CORS: al origen permitido le concede el origen y las credenciales (los hooks no corren tras hijack, se escriben a mano)", async () => {
    const { sessionCookieOf, connect } = await makeApp();

    const stream = await connect({ cookie: sessionCookieOf(NORTE), origin: ALLOWED_ORIGIN });

    expect(stream.response.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
    expect(stream.response.headers.get("access-control-allow-credentials")).toBe("true");
    expect(stream.response.headers.get("vary")).toBe("Origin");
  });

  it.each([["un origen ajeno", { origin: "https://evil.example" }], ["sin Origin (curl, el móvil)", {}]])("CORS: %s no recibe Access-Control-Allow-Origin", async (_label, extra) => {
    const { sessionCookieOf, connect } = await makeApp();

    const stream = await connect({ cookie: sessionCookieOf(NORTE), ...extra });

    expect(stream.response.status).toBe(200);
    expect(stream.response.headers.get("access-control-allow-origin")).toBeNull();
    expect(stream.response.headers.get("access-control-allow-credentials")).toBeNull();
  });
});

describe("contenido del stream", () => {
  it("el PRIMER evento es el snapshot, con id = cursor y datos que cumplen el contrato", async () => {
    const { sessionCookieOf, connect } = await makeApp();

    const stream = await connect({ cookie: sessionCookieOf(NORTE) });
    const first = await stream.next();

    expect(first.event).toBe("snapshot");
    expect(first.id).toBe("7");
    const snapshot = sseSnapshotSchema.parse(JSON.parse(first.data ?? "null"));
    expect(snapshot).toEqual({ serverTime: "2026-10-06T12:00:00.000Z", cursor: "7", vehicles: [STREAM_VEHICLE], alerts: [] });
  });

  it("después del snapshot llegan los eventos en vivo con id = seq y datos del contrato; lo repetido o más viejo no llega", async () => {
    const { hub, sessionCookieOf, connect } = await makeApp();
    const stream = await connect({ cookie: sessionCookieOf(NORTE) });
    await stream.next();
    const alert = alertAt("12");

    hub.publish(NORTE.tenantId, { type: "vehicle.state", state: vehicleAt("7") });
    hub.publish(NORTE.tenantId, { type: "vehicle.state", state: vehicleAt("9", { movement: "moving", stoppedSince: null }) });
    hub.publish(NORTE.tenantId, { type: "alert", alert });

    const state = await stream.next();
    const received = await stream.next();
    expect(state).toMatchObject({ event: "vehicle.state", id: "9" });
    expect(sseVehicleStateSchema.parse(JSON.parse(state.data ?? "null")).state).toMatchObject({ vehicleId: STREAM_VEHICLE.vehicleId, movement: "moving", seq: "9" });
    expect(received).toMatchObject({ event: "alert", id: "12" });
    expect(sseAlertSchema.parse(JSON.parse(received.data ?? "null")).alert).toEqual(alert);
  });

  it("un evento que llega mientras se lee el snapshot se entrega DESPUÉS de él", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const snapshots: FleetSnapshotReader = {
      read: async () => {
        await gate;
        return { vehicles: [STREAM_VEHICLE], alerts: [] };
      },
    };
    const { hub, sessionCookieOf, connect } = await makeApp({ snapshots });
    const subscribe = vi.spyOn(hub, "subscribe");
    const opening = connect({ cookie: sessionCookieOf(NORTE) });
    await waitFor("la suscripción del stream (el snapshot sigue leyéndose)", () => subscribe.mock.calls.length > 0);
    hub.publish(NORTE.tenantId, { type: "vehicle.state", state: vehicleAt("8") });
    release();

    const stream = await opening;

    expect(await stream.next()).toMatchObject({ event: "snapshot", id: "7" });
    expect(await stream.next()).toMatchObject({ event: "vehicle.state", id: "8" });
  });

  it("Last-Event-ID se ignora a propósito: una reconexión recibe siempre un snapshot nuevo", async () => {
    const { sessionCookieOf, connect, snapshotRead } = await makeApp();

    const stream = await connect({ cookie: sessionCookieOf(NORTE), "last-event-id": "999999" });

    expect(await stream.next()).toMatchObject({ event: "snapshot", id: "7" });
    expect(snapshotRead).toHaveBeenCalledTimes(1);
  });
});

describe("reconexión del cliente (retry)", () => {
  it("el PRIMER frame (el snapshot) lleva retry = base + jitter, y los siguientes no", async () => {
    const { hub, sessionCookieOf, connect } = await makeApp({ reconnect: { baseMs: 3_000, jitterMs: 4_000 }, random: () => 0.5 });
    const stream = await connect({ cookie: sessionCookieOf(NORTE) });

    const first = await stream.next();
    hub.publish(NORTE.tenantId, { type: "vehicle.state", state: vehicleAt("9") });
    const next = await stream.next();

    expect(first).toMatchObject({ event: "snapshot", retry: 5_000 });
    expect(next).toMatchObject({ event: "vehicle.state", retry: undefined });
  });

  it("el jitter reparte las reconexiones: con otro aleatorio, otro retry dentro de [base, base + jitter)", async () => {
    const values = [0, 0.999];
    const { sessionCookieOf, connect } = await makeApp({ reconnect: { baseMs: 1_000, jitterMs: 1_000 }, random: () => values.shift() ?? 0 });

    const a = await (await connect({ cookie: sessionCookieOf(NORTE) })).next();
    const b = await (await connect({ cookie: sessionCookieOf(NORTE) })).next();

    expect(a.retry).toBe(1_000);
    expect(b.retry).toBe(1_999);
  });
});

describe("draining (apagado)", () => {
  it("tras cerrar los streams, uno nuevo recibe 503 shutting_down con Retry-After y CORS, ANTES de hijack (JSON, sin leer el snapshot)", async () => {
    const { fleetStream, sessionCookieOf, connect, url, snapshotRead } = await makeApp();
    const open = await connect({ cookie: sessionCookieOf(NORTE) });
    await open.next();
    const readsBefore = snapshotRead.mock.calls.length;

    fleetStream.closeAll();
    expect(await open.closed()).toBe(true);
    const rejected = await fetch(url, { headers: { cookie: sessionCookieOf(NORTE), origin: ALLOWED_ORIGIN } });

    expect(rejected.status).toBe(503);
    expect(apiErrorSchema.parse(await rejected.json()).error.code).toBe("shutting_down");
    expect(rejected.headers.get("retry-after")).toBe("5");
    expect(rejected.headers.get("content-type")).toContain("application/json");
    expect(rejected.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
    expect(snapshotRead.mock.calls.length).toBe(readsBefore);
  });

  it("sin sesión sigue siendo 401 aunque la réplica se esté apagando", async () => {
    const { fleetStream, app } = await makeApp();
    fleetStream.closeAll();

    const response = await app.inject({ method: "GET", url: "/v1/stream" });

    expect(response.statusCode).toBe(401);
  });
});

describe("límite de conexiones nuevas por usuario", () => {
  it("cuenta por USUARIO y no por IP: el mismo usuario pasa el límite, otro usuario desde la misma IP no", async () => {
    const { sessionCookieOf, connect, url } = await makeApp({ streamRateLimit: { max: 2, timeWindowMs: 60_000 } });
    const cookie = sessionCookieOf(NORTE);

    const first = await connect({ cookie });
    const second = await connect({ cookie });
    await first.next();
    await second.next();
    const blocked = await fetch(url, { headers: { cookie, origin: ALLOWED_ORIGIN } });
    const other = await connect({ cookie: sessionCookieOf(SUR) });

    expect(blocked.status).toBe(429);
    expect(apiErrorSchema.parse(await blocked.json()).error.code).toBe("rate_limited");
    expect(blocked.headers.get("retry-after")).not.toBeNull();
    expect(blocked.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
    expect((await other.next()).event).toBe("snapshot");
  });

  it("sin sesión válida cuenta por IP: los 401 también agotan el límite", async () => {
    const { app } = await makeApp({ streamRateLimit: { max: 2, timeWindowMs: 60_000 } });
    const get = () => app.inject({ method: "GET", url: "/v1/stream", headers: { cookie: "fleet_session=basura" } });

    expect((await get()).statusCode).toBe(401);
    expect((await get()).statusCode).toBe(401);
    expect((await get()).statusCode).toBe(429);
  });
});

describe("heartbeat", () => {
  it("escribe `: heartbeat` cada heartbeatMs, como comentario (sin id ni data), y deja de hacerlo al cerrarse la conexión", async () => {
    const { sessionCookieOf, connect } = await makeApp({ heartbeatMs: 15_000 });
    // Solo los intervalos son falsos: el socket y los timeouts del cliente siguen en tiempo real.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const stream = await connect({ cookie: sessionCookieOf(NORTE) });
    await stream.next();
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1);

    vi.advanceTimersByTime(14_999);
    await expect(stream.next(150)).rejects.toThrow(/Se agotaron/);
    vi.advanceTimersByTime(1);
    const beat = await stream.next();
    vi.advanceTimersByTime(15_000);
    const second = await stream.next();

    expect(beat).toEqual({ id: undefined, event: undefined, data: undefined, retry: undefined, comment: SSE_HEARTBEAT_COMMENT });
    expect(second.comment).toBe(SSE_HEARTBEAT_COMMENT);

    stream.close();
    await waitFor("el intervalo del heartbeat limpiado al cerrar", () => vi.getTimerCount() === 0);
  });
});

describe("límite de streams por usuario", () => {
  it("el stream que pasa el límite recibe 429 con apiErrorSchema y CORS (antes de hijack); otro usuario no se ve afectado", async () => {
    const { sessionCookieOf, connect, url } = await makeApp({ streamLimits: { maxStreamsPerUser: 1 } });
    const cookie = sessionCookieOf(NORTE);
    const first = await connect({ cookie });
    await first.next();

    const rejected = await fetch(url, { headers: { cookie, origin: ALLOWED_ORIGIN } });

    expect(rejected.status).toBe(429);
    expect(apiErrorSchema.parse(await rejected.json()).error.code).toBe("rate_limited");
    expect(rejected.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
    expect(rejected.headers.get("content-type")).toContain("application/json");
    // El primero sigue vivo y otro usuario (del mismo tenant) abre el suyo.
    const other = await connect({ cookie: sessionCookieOf({ userId: randomUUID(), tenantId: NORTE.tenantId }) });
    expect((await other.next()).event).toBe("snapshot");
  });

  it("al cerrar el primero se libera el cupo", async () => {
    const { sessionCookieOf, connect, url } = await makeApp({ streamLimits: { maxStreamsPerUser: 1 } });
    const cookie = sessionCookieOf(NORTE);
    const first = await connect({ cookie });
    await first.next();
    first.close();

    // El cierre del servidor se entera de forma asíncrona: se reintenta hasta que el cupo se libera.
    const deadline = Date.now() + 3_000;
    let status = 0;
    while (status !== 200 && Date.now() < deadline) {
      const response = await fetch(url, { headers: { cookie } });
      status = response.status;
      await response.body?.cancel();
      if (status !== 200) await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(status).toBe(200);
  });
});

describe("errores y cierre", () => {
  it("si el snapshot falla responde 500 con apiErrorSchema (aún no se había entregado la conexión), sin detalle interno", async () => {
    const snapshots: FleetSnapshotReader = { read: () => Promise.reject(new Error('relation "vehicle_state" does not exist')) };
    const { app, sessionCookieOf, raw } = await makeApp({ snapshots });

    const response = await app.inject({ method: "GET", url: "/v1/stream", headers: { cookie: sessionCookieOf(NORTE) } });

    expect(response.statusCode).toBe(500);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe("internal_error");
    expect(response.body).not.toContain("vehicle_state");
    expect(raw()).toContain("Error no controlado");
  });

  it("al cerrar el cliente se registra el cierre y el stream deja de recibir (limpieza del listener)", async () => {
    const { hub, sessionCookieOf, connect, logged } = await makeApp();
    const stream = await connect({ cookie: sessionCookieOf(NORTE) });
    await stream.next();

    stream.close();

    await waitFor("el cierre registrado", () => logged().some((line) => line["reason"] === "client_closed"));
    expect(() => hub.publish(NORTE.tenantId, { type: "vehicle.state", state: vehicleAt("30") })).not.toThrow();
  });

  it("si el cliente cuelga mientras se lee el snapshot, al entregar la conexión se limpia todo: suscripción, cupo del usuario y latido", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const snapshots: FleetSnapshotReader = {
      read: async () => {
        await gate;
        return { vehicles: [], alerts: [] };
      },
    };
    const { app, hub, sessionCookieOf, url, connect, logged } = await makeApp({ snapshots, streamLimits: { maxStreamsPerUser: 1 } });
    const subscribe = vi.spyOn(hub, "subscribe");
    const cookie = sessionCookieOf(NORTE);
    const controller = new AbortController();
    const abandoned = fetch(url, { headers: { cookie }, signal: controller.signal }).catch(() => undefined);
    await waitFor("la suscripción del stream (el snapshot sigue leyéndose)", () => subscribe.mock.calls.length > 0);

    controller.abort();
    await abandoned;
    // El servidor se entera del cierre de forma asíncrona: se espera a que no quede ninguna conexión ANTES de liberar el snapshot.
    let open = 1;
    const deadline = Date.now() + 3_000;
    while (open > 0 && Date.now() < deadline) {
      open = await new Promise<number>((resolve) => app.server.getConnections((_error, count) => resolve(count)));
      if (open > 0) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(open).toBe(0);
    release();

    await waitFor("el cierre registrado", () => logged().some((line) => line["reason"] === "client_closed"));
    // El cupo (límite 1) quedó libre: otra conexión del mismo usuario entra.
    const next = await connect({ cookie });
    expect((await next.next()).event).toBe("snapshot");
  });

  it("el apagado ordenado (closeAll) corta los streams abiertos", async () => {
    const { fleetStream, sessionCookieOf, connect } = await makeApp();
    const stream = await connect({ cookie: sessionCookieOf(NORTE) });
    await stream.next();

    fleetStream.closeAll();

    expect(await stream.closed()).toBe(true);
  });
});

describe("privacidad en los logs", () => {
  it("registra aperturas y cierres con conteos y correlationId, y nunca la placa, la posición ni la cookie", async () => {
    const { fleetStream, hub, sessionCookieOf, connect, raw, logged } = await makeApp();
    const cookie = sessionCookieOf(NORTE);
    const stream = await connect({ cookie, "x-correlation-id": "corr-sse-2" });
    await stream.next();
    hub.publish(NORTE.tenantId, { type: "vehicle.state", state: vehicleAt("40") });
    await stream.next();
    fleetStream.closeAll();
    await waitFor("el cierre registrado", () => logged().some((line) => line["reason"] === "shutdown"));

    const opened = logged().find((line) => line["msg"] === "Stream SSE abierto");
    expect(opened).toMatchObject({ tenantId: NORTE.tenantId, correlationId: "corr-sse-2", tenantStreams: 1, totalStreams: 1 });
    for (const forbidden of [STREAM_VEHICLE.plate, "-75.5636", "6.2518", "fleet_session", cookie.split("=")[1] ?? "no-hay-cookie"]) expect(raw()).not.toContain(forbidden);
  });
});
