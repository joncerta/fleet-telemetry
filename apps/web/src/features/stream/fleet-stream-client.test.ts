import { SSE_EVENTS } from "@fleet/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeEventSources } from "../../test-support/fake-event-source";
import { alert, snapshot, vehicleState } from "../../test-support/fixtures";
import { createFleetStream, type ConnectionStatus, type FleetStreamCallbacks, type SessionProbe } from "./fleet-stream-client";

const HEARTBEAT_MS = 15_000;
const URL = "http://localhost:4002/v1/stream";

function setup(options: { probe?: SessionProbe; random?: () => number } = {}) {
  const sources = fakeEventSources();
  const statuses: ConnectionStatus[] = [];
  const logs: { message: string; details: unknown }[] = [];
  const callbacks = {
    onSnapshot: vi.fn<FleetStreamCallbacks["onSnapshot"]>(),
    onVehicleState: vi.fn<FleetStreamCallbacks["onVehicleState"]>(),
    onAlert: vi.fn<FleetStreamCallbacks["onAlert"]>(),
    onStatus: (status: ConnectionStatus) => statuses.push(status),
    onUnauthorized: vi.fn<FleetStreamCallbacks["onUnauthorized"]>(),
  };
  const probe = vi.fn<SessionProbe>(options.probe ?? (() => Promise.resolve("authenticated")));
  const stream = createFleetStream(
    {
      url: URL,
      createEventSource: sources.factory,
      probeSession: probe,
      heartbeatMs: HEARTBEAT_MS,
      random: options.random ?? (() => 0),
      log: (message, details) => logs.push({ message, details }),
    },
    callbacks,
  );
  return { sources, statuses, logs, callbacks, probe, stream };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("createFleetStream", () => {
  it("abre UNA conexión a la URL del stream y empieza en 'connecting'", () => {
    const { sources, statuses, stream } = setup();
    stream.start();
    stream.start();

    expect(sources.created).toHaveLength(1);
    expect(sources.latest().url).toBe(URL);
    expect(statuses).toEqual(["connecting"]);
  });

  it("el snapshot llega primero: los eventos anteriores se ignoran y los posteriores se entregan", () => {
    const { sources, statuses, callbacks, stream } = setup();
    stream.start();
    const source = sources.latest();
    source.open();

    source.emit(SSE_EVENTS.vehicleState, { state: vehicleState({ seq: "5" }) });
    expect(callbacks.onVehicleState).not.toHaveBeenCalled();

    source.emit(SSE_EVENTS.snapshot, snapshot());
    expect(callbacks.onSnapshot).toHaveBeenCalledTimes(1);
    expect(statuses.at(-1)).toBe("live");

    source.emit(SSE_EVENTS.vehicleState, { state: vehicleState({ seq: "101" }) });
    source.emit(SSE_EVENTS.alert, { alert: alert() });
    expect(callbacks.onVehicleState).toHaveBeenCalledWith(expect.objectContaining({ seq: "101" }));
    expect(callbacks.onAlert).toHaveBeenCalledTimes(1);
  });

  it("lee con la variante tolerante: un movement desconocido llega como 'unknown'", () => {
    const { sources, callbacks, stream } = setup();
    stream.start();
    const source = sources.latest();
    source.emit(SSE_EVENTS.snapshot, snapshot());
    source.emit(SSE_EVENTS.vehicleState, { state: { ...vehicleState(), movement: "towed" } });
    expect(callbacks.onVehicleState).toHaveBeenCalledWith(expect.objectContaining({ movement: "unknown" }));
  });

  it("descarta un evento inválido y lo registra SIN el payload", () => {
    const { sources, callbacks, logs, stream } = setup();
    stream.start();
    const source = sources.latest();
    source.emit(SSE_EVENTS.snapshot, snapshot());

    source.emit(SSE_EVENTS.vehicleState, { state: { ...vehicleState({ plate: "NRT999" }), lat: 999 } });
    source.emit(SSE_EVENTS.alert, "{no es json");

    expect(callbacks.onVehicleState).not.toHaveBeenCalled();
    expect(callbacks.onAlert).not.toHaveBeenCalled();
    expect(logs.filter((log) => log.message === "Evento SSE inválido descartado")).toHaveLength(2);
    expect(JSON.stringify(logs)).not.toContain("NRT999");
    expect(JSON.stringify(logs)).not.toContain("999");
  });

  it("tras un corte con la conexión viva, reconecta con backoff y el snapshot nuevo vuelve a llegar", async () => {
    const { sources, statuses, callbacks, probe, stream } = setup();
    stream.start();
    const first = sources.latest();
    first.emit(SSE_EVENTS.snapshot, snapshot({ cursor: "100" }));

    first.fail();
    expect(first.closed).toBe(true);
    expect(statuses.at(-1)).toBe("reconnecting");
    // Con la conexión ya viva, el corte no es un 401: no se consulta la sesión.
    expect(probe).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(999);
    expect(sources.created).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sources.created).toHaveLength(2);

    sources.latest().emit(SSE_EVENTS.snapshot, snapshot({ cursor: "180" }));
    expect(callbacks.onSnapshot).toHaveBeenCalledTimes(2);
    expect(callbacks.onSnapshot.mock.calls[1]?.[0].cursor).toBe("180");
    expect(statuses.at(-1)).toBe("live");
  });

  it("los eventos de una conexión ya cerrada no se entregan", () => {
    const { sources, callbacks, stream } = setup();
    stream.start();
    const first = sources.latest();
    first.emit(SSE_EVENTS.snapshot, snapshot());
    first.fail();

    first.emit(SSE_EVENTS.vehicleState, { state: vehicleState({ seq: "300" }) });
    expect(callbacks.onVehicleState).not.toHaveBeenCalled();
  });

  it("si falla antes del snapshot y la sesión no existe (401), se detiene y avisa sin reconectar", async () => {
    const { sources, callbacks, probe, stream } = setup({ probe: () => Promise.resolve("unauthorized") });
    stream.start();
    sources.latest().fail();
    await vi.runAllTimersAsync();

    expect(probe).toHaveBeenCalledTimes(1);
    expect(callbacks.onUnauthorized).toHaveBeenCalledTimes(1);
    expect(sources.created).toHaveLength(1);
  });

  it("si falla antes del snapshot con sesión vigente, reintenta con espera creciente y pasa a 'disconnected' a los 3 fallos", async () => {
    // random = 1: la espera es el tope de cada intento (1 s, 2 s, 4 s...).
    const { sources, statuses, stream } = setup({ random: () => 0.999_999 });
    stream.start();

    sources.latest().fail();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sources.created).toHaveLength(2);

    sources.latest().fail();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(sources.created).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sources.created).toHaveLength(3);

    sources.latest().fail();
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)).toBe("disconnected");
    await vi.advanceTimersByTimeAsync(4_000);
    expect(sources.created).toHaveLength(4);
  });

  it("sin ninguna señal durante 2 latidos, da la conexión por muerta y reconecta", async () => {
    const { sources, statuses, stream } = setup();
    stream.start();
    const first = sources.latest();
    first.open();
    first.emit(SSE_EVENTS.snapshot, snapshot());

    // Los eventos reinician la vigilancia.
    await vi.advanceTimersByTimeAsync(2 * HEARTBEAT_MS - 1_000);
    first.emit(SSE_EVENTS.vehicleState, { state: vehicleState({ seq: "101" }) });
    await vi.advanceTimersByTimeAsync(2 * HEARTBEAT_MS - 1_000);
    expect(first.closed).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(first.closed).toBe(true);
    expect(statuses.at(-1)).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sources.created).toHaveLength(2);
  });

  it("una conexión que nunca abre también se da por muerta", async () => {
    const { sources, probe, stream } = setup();
    stream.start();
    await vi.advanceTimersByTimeAsync(2 * HEARTBEAT_MS);
    expect(sources.latest().closed).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("stop cierra la conexión y cancela la reconexión pendiente", async () => {
    const { sources, stream } = setup();
    stream.start();
    sources.latest().emit(SSE_EVENTS.snapshot, snapshot());
    sources.latest().fail();

    stream.stop();
    await vi.runAllTimersAsync();
    expect(sources.created).toHaveLength(1);
    expect(sources.latest().closed).toBe(true);
  });

  it("reconnectNow reconecta sin esperar el backoff, pero no abre otra conexión si la actual está viva", async () => {
    const { sources, stream } = setup();
    stream.start();
    sources.latest().emit(SSE_EVENTS.snapshot, snapshot());
    stream.reconnectNow();
    expect(sources.created).toHaveLength(1);

    sources.latest().fail();
    stream.reconnectNow();
    expect(sources.created).toHaveLength(2);
    // La reconexión programada por el fallo ya no abre una tercera.
    await vi.runOnlyPendingTimersAsync();
    expect(sources.created).toHaveLength(2);
  });
});
