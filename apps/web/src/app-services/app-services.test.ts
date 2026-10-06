import type { Session } from "@fleet/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UnauthorizedError } from "../lib/api/http-client";
import { NOW_MS, snapshot, vehicleState } from "../test-support/fixtures";
import { createAppServices } from "./app-services";

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
  constructor(url: string, init?: EventSourceInit) {
    RecordingEventSource.opened.push({ url, init, source: this });
  }
  addEventListener(): void {}
  close(): void {
    this.closed = true;
  }
}

function withSessionAndData() {
  const services = createAppServices(env);
  services.sessionStore.getState().signedIn(session);
  services.fleetStore.getState().applySnapshot(snapshot({ vehicles: [vehicleState()] }), NOW_MS);
  return services;
}

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
});
