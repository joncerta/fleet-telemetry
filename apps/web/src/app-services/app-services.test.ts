import type { Session } from "@fleet/contracts";
import { SSE_EVENTS } from "@fleet/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UnauthorizedError } from "../lib/api/http-client";
import { NOW_MS, snapshot, vehicleState } from "../test-support/fixtures";
import { createAppServices, SESSION_CHANNEL_NAME, type SessionChannelLike } from "./app-services";

const env = { fleetApiUrl: "http://api.test", agentUrl: "http://agent.test", mapStyleUrl: "https://tiles.test/style" };
const session: Session = {
  user: { userId: "0f9a7c1e-0000-4000-8000-000000000001", email: "operador@norte.test", name: "Operador Norte" },
  tenant: { tenantId: "f1ee7000-0000-4000-8000-000000000001", name: "Flota Norte" },
};
const unauthorized = () => new Response(JSON.stringify({ error: { code: "unauthorized", message: "Sesión ausente." } }), { status: 401 });

/** `EventSource` del navegador, falso: guarda con qué se abrió cada conexión. */
class RecordingEventSource {
  static opened: { url: string; init: EventSourceInit | undefined; source: RecordingEventSource }[] = [];
  closed = false;
  readonly listeners = new Map<string, ((event: Event) => void)[]>();
  constructor(url: string, init?: EventSourceInit) {
    RecordingEventSource.opened.push({ url, init, source: this });
  }
  addEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
  close(): void {
    this.closed = true;
  }
}

/** Canal entre pestañas falso: `deliver` simula el mensaje de otra pestaña; `posted` guarda lo que esta publica. */
class FakeSessionChannel implements SessionChannelLike {
  posted: unknown[] = [];
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  closed = false;
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  close(): void {
    this.closed = true;
  }
  deliver(data: unknown): void {
    this.onmessage?.(new MessageEvent("message", { data }));
  }
}

function withSessionAndData() {
  const channel = new FakeSessionChannel();
  const names: string[] = [];
  const services = createAppServices(env, {
    createSessionChannel: (name) => {
      names.push(name);
      return channel;
    },
  });
  expect(names).toEqual([SESSION_CHANNEL_NAME]);
  services.sessionStore.getState().signedIn(session);
  services.fleetStore.getState().applySnapshot(snapshot({ vehicles: [vehicleState()] }), NOW_MS);
  return Object.assign(services, { channel });
}

const jsonOf = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const otherTenantSession: Session = {
  user: { userId: "0f9a7c1e-0000-4000-8000-000000000002", email: "operador@sur.test", name: "Operador Sur" },
  tenant: { tenantId: "f1ee7000-0000-4000-8000-000000000002", name: "Flota Sur" },
};

beforeEach(() => {
  vi.useFakeTimers();
  RecordingEventSource.opened = [];
  vi.stubGlobal("EventSource", RecordingEventSource);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("createAppServices", () => {
  it("un 401 de cualquier lectura lleva a 'sin sesión' y borra los datos del tenant", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(unauthorized())));
    const services = withSessionAndData();

    await expect(services.api.getSummary()).rejects.toBeInstanceOf(UnauthorizedError);
    expect(services.sessionStore.getState()).toMatchObject({ status: "anonymous", session: null });
    expect(services.fleetStore.getState()).toMatchObject({ ready: false, vehicles: {} });
  });

  it("el stream se abre UNA vez, con withCredentials y sin token en la URL; un 401 lo cierra", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(unauthorized())));
    const services = withSessionAndData();
    const release = services.fleetSync.acquire();
    services.fleetSync.acquire();

    expect(RecordingEventSource.opened).toHaveLength(1);
    expect(RecordingEventSource.opened[0]?.url).toBe("http://api.test/v1/stream");
    expect(RecordingEventSource.opened[0]?.init).toEqual({ withCredentials: true });

    // Una lectura con 401: se corta el stream (dispose) además de borrar los datos.
    await services.api.getZones().catch(() => undefined);
    expect(RecordingEventSource.opened[0]?.source.closed).toBe(true);
    release();
  });

  it("signOut corta el stream, avisa a la API y borra los datos aunque la API no responda", async () => {
    const fetch = vi.fn((_url: string, init: RequestInit) =>
      init.method === "POST" ? Promise.reject(new TypeError("Failed to fetch")) : Promise.resolve(unauthorized()),
    );
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const services = withSessionAndData();
    services.fleetSync.acquire();

    await services.signOut();
    expect(fetch).toHaveBeenCalledWith("http://api.test/v1/auth/logout", expect.objectContaining({ method: "POST", credentials: "include" }));
    expect(RecordingEventSource.opened[0]?.source.closed).toBe(true);
    expect(services.sessionStore.getState().status).toBe("anonymous");
    expect(services.fleetStore.getState().vehicles).toEqual({});
  });

  it("un mensaje de otra pestaña (cerró sesión o entró otro usuario) borra los datos, cierra el stream y lleva al login", () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
    const services = withSessionAndData();
    services.fleetSync.acquire();

    services.channel.deliver({ type: "otra-cosa" });
    expect(services.sessionStore.getState().status).toBe("authenticated");

    services.channel.deliver({ type: "session-changed" });
    expect(services.sessionStore.getState()).toMatchObject({ status: "anonymous", session: null });
    expect(services.fleetStore.getState()).toMatchObject({ ready: false, vehicles: {}, alerts: {} });
    expect(RecordingEventSource.opened[0]?.source.closed).toBe(true);
  });

  it("signIn y signOut avisan a las demás pestañas; sin canal (sin BroadcastChannel) funcionan igual", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(null, { status: 204 }))));
    const services = withSessionAndData();
    services.signIn(session);
    expect(services.channel.posted).toEqual([{ type: "session-changed" }]);
    await services.signOut();
    expect(services.channel.posted).toHaveLength(2);

    const alone = createAppServices(env, { createSessionChannel: () => null });
    alone.signIn(session);
    expect(alone.sessionStore.getState().status).toBe("authenticated");
    await alone.signOut();
    expect(alone.sessionStore.getState().status).toBe("anonymous");
  });

  it("si al llegar un snapshot la identidad de la cookie cambió (otro usuario o tenant), borra el store y va al login", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => (url.endsWith("/v1/auth/session") ? Promise.resolve(jsonOf(200, otherTenantSession)) : Promise.reject(new TypeError("Failed to fetch")))),
    );
    const services = withSessionAndData();
    services.fleetSync.acquire();

    RecordingEventSource.opened[0]?.source.emit(SSE_EVENTS.snapshot, snapshot({ vehicles: [vehicleState({ plate: "SUR101" })] }));
    await vi.advanceTimersByTimeAsync(0);

    expect(services.sessionStore.getState()).toMatchObject({ status: "anonymous", session: null });
    expect(services.fleetStore.getState()).toMatchObject({ ready: false, vehicles: {} });
    expect(RecordingEventSource.opened[0]?.source.closed).toBe(true);
  });

  it("si la identidad sigue igual, el snapshot se conserva; si la verificación no responde, tampoco se borra nada", async () => {
    const fetchMock = vi.fn((url: string) => (url.endsWith("/v1/auth/session") ? Promise.resolve(jsonOf(200, session)) : Promise.reject(new TypeError("Failed to fetch"))));
    vi.stubGlobal("fetch", fetchMock);
    const services = withSessionAndData();
    services.fleetSync.acquire();

    RecordingEventSource.opened[0]?.source.emit(SSE_EVENTS.snapshot, snapshot({ vehicles: [vehicleState({ plate: "NRT202" })] }));
    await vi.advanceTimersByTimeAsync(0);
    expect(services.sessionStore.getState().status).toBe("authenticated");
    expect(Object.values(services.fleetStore.getState().vehicles).map((vehicle) => vehicle.plate)).toEqual(["NRT202"]);
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/v1/auth/session"))).toBe(true);

    fetchMock.mockImplementation(() => Promise.reject(new TypeError("Failed to fetch")));
    RecordingEventSource.opened[0]?.source.emit(SSE_EVENTS.snapshot, snapshot({ vehicles: [vehicleState({ plate: "NRT203" })] }));
    await vi.advanceTimersByTimeAsync(0);
    expect(services.sessionStore.getState().status).toBe("authenticated");
  });
});
