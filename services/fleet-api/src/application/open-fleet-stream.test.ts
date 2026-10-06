import { randomUUID } from "node:crypto";
import type { Alert, VehicleState } from "@fleet/contracts";
import { createLogger } from "@fleet/platform";
import { describe, expect, it, vi } from "vitest";
import type { AuthIdentity } from "../domain/identity.js";
import type { FleetStreamEvent } from "../domain/stream-ordering.js";
import { createFleetEventHub } from "./fleet-event-hub.js";
import { createOpenFleetStream, type OpenFleetStreamLimits } from "./open-fleet-stream.js";
import type { FleetSnapshotData, FleetSnapshotReader, FleetStreamMessage, FleetStreamSink } from "./ports.js";

const NOW = new Date("2026-10-06T12:00:00.000Z");
const PLATE = "PLACA-SECRETA";

const vehicle = (vehicleId: string, seq: number): VehicleState => ({
  vehicleId,
  plate: PLATE,
  lon: -75.5636,
  lat: 6.2518,
  recordedAt: "2026-10-06T11:59:00.000Z",
  receivedAt: "2026-10-06T11:59:01.000Z",
  speedMps: 0,
  headingDeg: null,
  movement: "stopped",
  stoppedSince: "2026-10-06T11:30:00.000Z",
  zoneIds: [],
  mocked: false,
  lowAccuracy: false,
  seq: String(seq),
});

const alert = (alertId: string, seq: number, resolved = false): Alert => ({
  alertId,
  vehicleId: randomUUID(),
  plate: PLATE,
  type: "critical_zone_stop",
  zoneId: null,
  zoneName: null,
  startedAt: "2026-10-06T11:30:00.000Z",
  raisedAt: "2026-10-06T11:50:00.000Z",
  resolvedAt: resolved ? "2026-10-06T11:55:00.000Z" : null,
  seq: String(seq),
});

const stateEvent = (state: VehicleState): FleetStreamEvent => ({ type: "vehicle.state", state });
const alertEvent = (value: Alert): FleetStreamEvent => ({ type: "alert", alert: value });

const identityOf = (tenantId: string = randomUUID()): AuthIdentity => ({ userId: randomUUID(), tenantId });

/** Conexión falsa: guarda lo que se le entrega; `end()` la cierra y avisa a quien se registró. */
function makeSink() {
  const messages: FleetStreamMessage[] = [];
  const closeListeners: (() => void)[] = [];
  const state = { pending: 0, ended: false, failDelivery: false };
  const sink: FleetStreamSink = {
    deliver: (message) => {
      if (state.failDelivery) throw new Error("socket cerrado");
      messages.push(message);
    },
    pendingBytes: () => state.pending,
    end: () => {
      if (state.ended) return;
      state.ended = true;
      for (const listener of closeListeners) listener();
    },
    onClose: (listener) => void closeListeners.push(listener),
  };
  return { sink, messages, state, clientCloses: () => sink.end() };
}

/** Lector de snapshot que se resuelve cuando el test lo decide: permite publicar eventos MIENTRAS se lee. */
function makeGatedReader(data: FleetSnapshotData) {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const read = vi.fn<FleetSnapshotReader["read"]>(async () => {
    await gate;
    return data;
  });
  return { reader: { read } satisfies FleetSnapshotReader, release, read };
}

const LIMITS: OpenFleetStreamLimits = { maxStreamsPerUser: 2, maxPendingBytes: 1_000, maxBufferedEvents: 100 };

function makeUseCase(options: { reader?: FleetSnapshotReader; limits?: Partial<OpenFleetStreamLimits> } = {}) {
  const lines: string[] = [];
  const logger = createLogger({ service: "fleet-api-test", level: "info", destination: { write: (line: string) => void lines.push(line) } });
  const hub = createFleetEventHub({ logger });
  const subscribe = vi.spyOn(hub, "subscribe");
  const reader = options.reader ?? { read: () => Promise.resolve({ vehicles: [], alerts: [] }) };
  const stream = createOpenFleetStream({
    subscriptions: hub,
    snapshots: reader,
    clock: { now: () => NOW },
    logger,
    limits: { ...LIMITS, ...options.limits },
  });
  return { stream, hub, subscribe, logs: () => lines.join("\n") };
}

const context = (identity: AuthIdentity) => ({ identity, correlationId: "corr-1" });

describe("snapshot primero", () => {
  it("el primer mensaje es el snapshot con id = cursor (el máximo seq incluido), la hora del servidor y los datos del tenant", async () => {
    const v1 = vehicle(randomUUID(), 7);
    const v2 = vehicle(randomUUID(), 12);
    const a1 = alert(randomUUID(), 9);
    const { stream } = makeUseCase({ reader: { read: () => Promise.resolve({ vehicles: [v1, v2], alerts: [a1] }) } });
    const { sink, messages } = makeSink();

    const result = await stream.open(context(identityOf()), () => sink);

    expect(result).toEqual({ status: "opened" });
    expect(messages).toEqual([{ event: "snapshot", id: "12", data: { serverTime: NOW.toISOString(), cursor: "12", vehicles: [v1, v2], alerts: [a1] } }]);
  });

  it("sin nada en la base el cursor es 0", async () => {
    const { stream } = makeUseCase();
    const { sink, messages } = makeSink();

    await stream.open(context(identityOf()), () => sink);

    expect(messages).toEqual([{ event: "snapshot", id: "0", data: { serverTime: NOW.toISOString(), cursor: "0", vehicles: [], alerts: [] } }]);
  });

  it("el tenant de la lectura y de la suscripción es el de la identidad", async () => {
    const identity = identityOf();
    const read = vi.fn<FleetSnapshotReader["read"]>(() => Promise.resolve({ vehicles: [], alerts: [] }));
    const { stream, subscribe } = makeUseCase({ reader: { read } });

    await stream.open(context(identity), () => makeSink().sink);

    expect(read).toHaveBeenCalledExactlyOnceWith(identity.tenantId);
    expect(subscribe).toHaveBeenCalledExactlyOnceWith(identity.tenantId, expect.any(Function));
  });

  it("un seq mayor que el cursor se compara como entero (no como texto)", async () => {
    const v = vehicle(randomUUID(), 9);
    const { stream, hub } = makeUseCase({ reader: { read: () => Promise.resolve({ vehicles: [v], alerts: [] }) } });
    const { sink, messages } = makeSink();
    const identity = identityOf();
    await stream.open(context(identity), () => sink);

    hub.publish(identity.tenantId, stateEvent({ ...v, seq: "10" }));

    expect(messages.map((m) => m.id)).toEqual(["9", "10"]);
  });
});

describe("buffer durante el snapshot (sin carreras)", () => {
  it("los eventos que llegan mientras se lee el snapshot se entregan DESPUÉS de él y solo los más nuevos que el snapshot, por vehículo y por alerta", async () => {
    const identity = identityOf();
    const inSnapshot = vehicle(randomUUID(), 10);
    const otherVehicle = vehicle(randomUUID(), 4);
    const activeAlert = alert(randomUUID(), 8);
    const { reader, release } = makeGatedReader({ vehicles: [inSnapshot, otherVehicle], alerts: [activeAlert] });
    const { stream, hub } = makeUseCase({ reader });
    const { sink, messages } = makeSink();

    const opening = stream.open(context(identity), () => sink);
    // Mientras se lee: uno viejo (<= snapshot) y uno nuevo del mismo vehículo, una versión vieja y una resolución nueva de la alerta, y un
    // evento con seq MENOR que el cursor (10) pero MÁS NUEVO que lo que el snapshot tiene de ese vehículo (4): es legítimo (nextval no es monótono).
    hub.publish(identity.tenantId, stateEvent({ ...inSnapshot, seq: "9" }));
    hub.publish(identity.tenantId, stateEvent({ ...inSnapshot, seq: "11" }));
    hub.publish(identity.tenantId, alertEvent({ ...activeAlert, seq: "8" }));
    hub.publish(identity.tenantId, alertEvent({ ...activeAlert, seq: "13", resolvedAt: "2026-10-06T11:58:00.000Z" }));
    hub.publish(identity.tenantId, stateEvent({ ...otherVehicle, seq: "6" }));
    expect(messages).toEqual([]);
    release();
    await opening;

    expect(messages.map((m) => [m.event, m.id])).toEqual([
      ["snapshot", "10"],
      ["vehicle.state", "11"],
      ["alert", "13"],
      ["vehicle.state", "6"],
    ]);
  });

  it("un evento de un vehículo que el snapshot no tiene (su primer estado) se entrega aunque su seq sea menor que el cursor", async () => {
    const identity = identityOf();
    const { reader, release } = makeGatedReader({ vehicles: [vehicle(randomUUID(), 50)], alerts: [] });
    const { stream, hub } = makeUseCase({ reader });
    const { sink, messages } = makeSink();

    const opening = stream.open(context(identity), () => sink);
    hub.publish(identity.tenantId, stateEvent(vehicle(randomUUID(), 3)));
    release();
    await opening;

    expect(messages.map((m) => m.id)).toEqual(["50", "3"]);
  });

  it("en vivo: entrega con id = seq y descarta lo repetido o más viejo de cada vehículo", async () => {
    const identity = identityOf();
    const v = vehicle(randomUUID(), 5);
    const { stream, hub } = makeUseCase({ reader: { read: () => Promise.resolve({ vehicles: [v], alerts: [] }) } });
    const { sink, messages } = makeSink();
    await stream.open(context(identity), () => sink);

    hub.publish(identity.tenantId, stateEvent({ ...v, seq: "6" }));
    hub.publish(identity.tenantId, stateEvent({ ...v, seq: "6" }));
    hub.publish(identity.tenantId, stateEvent({ ...v, seq: "5" }));
    hub.publish(identity.tenantId, stateEvent({ ...v, seq: "7" }));

    expect(messages.map((m) => [m.event, m.id])).toEqual([
      ["snapshot", "5"],
      ["vehicle.state", "6"],
      ["vehicle.state", "7"],
    ]);
  });

  it("si se acumulan más eventos que el tope mientras se lee el snapshot, se corta la conexión (reconecta con un snapshot nuevo) y no se envía nada incompleto", async () => {
    const identity = identityOf();
    const { reader, release } = makeGatedReader({ vehicles: [], alerts: [] });
    const { stream, hub, logs } = makeUseCase({ reader, limits: { maxBufferedEvents: 2 } });
    const { sink, messages, state } = makeSink();

    const opening = stream.open(context(identity), () => sink);
    for (const seq of [1, 2, 3]) hub.publish(identity.tenantId, stateEvent(vehicle(randomUUID(), seq)));
    release();
    await opening;

    expect(state.ended).toBe(true);
    expect(messages.map((m) => m.event)).toEqual(["snapshot"]);
    expect(logs()).toContain("buffer_overflow");
  });
});

describe("aislamiento por tenant", () => {
  it("un stream solo recibe los eventos de su tenant", async () => {
    const norte = identityOf();
    const sur = identityOf();
    const { stream, hub } = makeUseCase();
    const north = makeSink();
    const south = makeSink();
    await stream.open(context(norte), () => north.sink);
    await stream.open(context(sur), () => south.sink);
    const norteVehicle = vehicle(randomUUID(), 20);
    const surAlert = alert(randomUUID(), 21);

    hub.publish(norte.tenantId, stateEvent(norteVehicle));
    hub.publish(sur.tenantId, alertEvent(surAlert));

    expect(north.messages.map((m) => m.event)).toEqual(["snapshot", "vehicle.state"]);
    expect(south.messages.map((m) => m.event)).toEqual(["snapshot", "alert"]);
    expect(JSON.stringify(south.messages)).not.toContain(norteVehicle.vehicleId);
    expect(JSON.stringify(north.messages)).not.toContain(surAlert.alertId);
  });

  it("dos usuarios del mismo tenant reciben ambos el evento", async () => {
    const tenantId = randomUUID();
    const { stream, hub } = makeUseCase();
    const first = makeSink();
    const second = makeSink();
    await stream.open(context(identityOf(tenantId)), () => first.sink);
    await stream.open(context(identityOf(tenantId)), () => second.sink);

    hub.publish(tenantId, stateEvent(vehicle(randomUUID(), 1)));

    expect(first.messages).toHaveLength(2);
    expect(second.messages).toHaveLength(2);
  });
});

describe("límite de streams por usuario", () => {
  it("el stream que pasa el límite se rechaza SIN leer el snapshot ni suscribirse; otro usuario no se ve afectado", async () => {
    const read = vi.fn<FleetSnapshotReader["read"]>(() => Promise.resolve({ vehicles: [], alerts: [] }));
    const { stream, subscribe } = makeUseCase({ reader: { read } });
    const identity = identityOf();
    await stream.open(context(identity), () => makeSink().sink);
    await stream.open(context(identity), () => makeSink().sink);
    read.mockClear();
    subscribe.mockClear();
    const attach = vi.fn(() => makeSink().sink);

    const third = await stream.open(context(identity), attach);
    const other = await stream.open(context({ ...identityOf(identity.tenantId) }), () => makeSink().sink);

    expect(third).toEqual({ status: "too_many_streams", limit: 2 });
    expect(attach).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(other).toEqual({ status: "opened" });
  });

  it("cerrar un stream libera su cupo", async () => {
    const { stream } = makeUseCase();
    const identity = identityOf();
    const first = makeSink();
    await stream.open(context(identity), () => first.sink);
    await stream.open(context(identity), () => makeSink().sink);

    first.clientCloses();

    expect(await stream.open(context(identity), () => makeSink().sink)).toEqual({ status: "opened" });
  });

  it("dos aperturas simultáneas del mismo usuario no pasan ambas el límite mientras se lee el snapshot", async () => {
    const { reader, release } = makeGatedReader({ vehicles: [], alerts: [] });
    const { stream } = makeUseCase({ reader, limits: { maxStreamsPerUser: 1 } });
    const identity = identityOf();

    const first = stream.open(context(identity), () => makeSink().sink);
    const second = await stream.open(context(identity), () => makeSink().sink);
    release();

    expect(second).toEqual({ status: "too_many_streams", limit: 1 });
    expect(await first).toEqual({ status: "opened" });
  });
});

describe("cliente lento", () => {
  it("si tras entregar un evento el socket tiene más bytes pendientes que el umbral, se corta la conexión y se libera todo", async () => {
    const identity = identityOf();
    const { stream, hub } = makeUseCase();
    const slow = makeSink();
    await stream.open(context(identity), () => slow.sink);
    slow.state.pending = LIMITS.maxPendingBytes + 1;

    hub.publish(identity.tenantId, stateEvent(vehicle(randomUUID(), 1)));
    hub.publish(identity.tenantId, stateEvent(vehicle(randomUUID(), 2)));

    expect(slow.state.ended).toBe(true);
    // El primero se entregó (y disparó el corte); el segundo ya no llega.
    expect(slow.messages.map((m) => m.event)).toEqual(["snapshot", "vehicle.state"]);
  });

  it("un cliente al día no se corta, aunque el snapshot haya sido grande", async () => {
    const identity = identityOf();
    const { stream, hub } = makeUseCase();
    const fine = makeSink();
    await stream.open(context(identity), () => fine.sink);
    fine.state.pending = LIMITS.maxPendingBytes;

    hub.publish(identity.tenantId, stateEvent(vehicle(randomUUID(), 1)));

    expect(fine.state.ended).toBe(false);
  });

  it("el cupo del cliente lento se libera: puede reconectar", async () => {
    const identity = identityOf();
    const { stream, hub } = makeUseCase({ limits: { maxStreamsPerUser: 1 } });
    const slow = makeSink();
    await stream.open(context(identity), () => slow.sink);
    slow.state.pending = LIMITS.maxPendingBytes + 1;
    hub.publish(identity.tenantId, stateEvent(vehicle(randomUUID(), 1)));

    expect(await stream.open(context(identity), () => makeSink().sink)).toEqual({ status: "opened" });
  });

  it("si escribir en la conexión falla (ya estaba cerrada), se cierra el stream sin propagar el error al que publica", async () => {
    const identity = identityOf();
    const { stream, hub } = makeUseCase();
    const broken = makeSink();
    await stream.open(context(identity), () => broken.sink);
    broken.state.failDelivery = true;

    expect(() => hub.publish(identity.tenantId, stateEvent(vehicle(randomUUID(), 1)))).not.toThrow();

    expect(broken.state.ended).toBe(true);
  });
});

describe("limpieza al cerrar", () => {
  it("al cerrar el cliente se cancela la suscripción: los eventos siguientes no se entregan y el cupo queda libre", async () => {
    const identity = identityOf();
    const { stream, hub } = makeUseCase();
    const closing = makeSink();
    await stream.open(context(identity), () => closing.sink);

    closing.clientCloses();
    hub.publish(identity.tenantId, stateEvent(vehicle(randomUUID(), 1)));

    expect(closing.messages.map((m) => m.event)).toEqual(["snapshot"]);
  });

  it("si el snapshot falla, el error se propaga, no se entrega la conexión y se libera la suscripción y el cupo", async () => {
    const identity = identityOf();
    const failing = { read: vi.fn<FleetSnapshotReader["read"]>(() => Promise.reject(new Error("connection terminated"))) };
    const { stream, hub } = makeUseCase({ reader: failing, limits: { maxStreamsPerUser: 1 } });
    const attach = vi.fn(() => makeSink().sink);

    await expect(stream.open(context(identity), attach)).rejects.toThrow("connection terminated");
    failing.read.mockResolvedValueOnce({ vehicles: [], alerts: [] });
    const retry = makeSink();

    expect(attach).not.toHaveBeenCalled();
    expect(await stream.open(context(identity), () => retry.sink)).toEqual({ status: "opened" });
    hub.publish(identity.tenantId, stateEvent(vehicle(randomUUID(), 1)));
    expect(retry.messages).toHaveLength(2);
  });

  it("si entregar la conexión falla, se deshace todo y el error se propaga", async () => {
    const identity = identityOf();
    const { stream } = makeUseCase({ limits: { maxStreamsPerUser: 1 } });

    await expect(
      stream.open(context(identity), () => {
        throw new Error("no se pudo");
      }),
    ).rejects.toThrow("no se pudo");

    expect(await stream.open(context(identity), () => makeSink().sink)).toEqual({ status: "opened" });
  });

  it("closeAll corta todos los streams abiertos y deja de entregarles", async () => {
    const tenantId = randomUUID();
    const { stream, hub } = makeUseCase();
    const a = makeSink();
    const b = makeSink();
    await stream.open(context(identityOf(tenantId)), () => a.sink);
    await stream.open(context(identityOf(randomUUID())), () => b.sink);

    stream.closeAll();
    hub.publish(tenantId, stateEvent(vehicle(randomUUID(), 1)));

    expect(a.state.ended).toBe(true);
    expect(b.state.ended).toBe(true);
    expect(a.messages).toHaveLength(1);
  });
});

describe("draining (apagado)", () => {
  it("tras closeAll los streams nuevos se rechazan como draining SIN leer el snapshot, suscribirse ni gastar cupo", async () => {
    const read = vi.fn<FleetSnapshotReader["read"]>(() => Promise.resolve({ vehicles: [], alerts: [] }));
    const { stream, subscribe } = makeUseCase({ reader: { read } });
    stream.closeAll();
    const attach = vi.fn(() => makeSink().sink);

    const result = await stream.open(context(identityOf()), attach);

    expect(result).toEqual({ status: "draining" });
    expect(read).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
  });

  it("un stream que se está abriendo cuando llega closeAll no se entrega: se deshace y responde draining", async () => {
    const gated = makeGatedReader({ vehicles: [], alerts: [] });
    const { stream } = makeUseCase({ reader: gated.reader, limits: { maxStreamsPerUser: 1 } });
    const identity = identityOf();
    const attach = vi.fn(() => makeSink().sink);
    const opening = stream.open(context(identity), attach);
    await vi.waitFor(() => expect(gated.read).toHaveBeenCalled());

    stream.closeAll();
    gated.release();

    expect(await opening).toEqual({ status: "draining" });
    expect(attach).not.toHaveBeenCalled();
  });

  it("los streams abiertos antes de closeAll se cortan como siempre", async () => {
    const { stream } = makeUseCase();
    const sink = makeSink();
    await stream.open(context(identityOf()), () => sink.sink);

    stream.closeAll();

    expect(sink.state.ended).toBe(true);
  });
});

describe("logs", () => {
  it("registran aperturas y cierres con conteos por tenant y el correlationId, y nunca placas ni posiciones", async () => {
    const identity = identityOf();
    const v = vehicle(randomUUID(), 3);
    const { stream, logs } = makeUseCase({ reader: { read: () => Promise.resolve({ vehicles: [v], alerts: [] }) } });
    const first = makeSink();
    await stream.open(context(identity), () => first.sink);
    await stream.open(context(identity), () => makeSink().sink);
    first.clientCloses();

    const text = logs();

    expect(text).toContain("Stream SSE abierto");
    expect(text).toContain("Stream SSE cerrado");
    expect(text).toContain(identity.tenantId);
    expect(text).toContain('"correlationId":"corr-1"');
    expect(text).toContain('"tenantStreams":2');
    expect(text).toContain('"reason":"client_closed"');
    for (const forbidden of [PLATE, "-75.5636", "6.2518"]) expect(text).not.toContain(forbidden);
  });
});

describe("createFleetEventHub", () => {
  it("un suscriptor que lanza no impide que los demás reciban el evento ni rompe a quien publica", () => {
    const warn = vi.fn();
    const hub = createFleetEventHub({ logger: { warn } });
    const received = vi.fn();
    const tenantId = randomUUID();
    hub.subscribe(tenantId, () => {
      throw new Error("falla");
    });
    hub.subscribe(tenantId, received);

    expect(() => hub.publish(tenantId, stateEvent(vehicle(randomUUID(), 1)))).not.toThrow();

    expect(received).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("cancelar la suscripción es idempotente y no afecta a las demás del tenant", () => {
    const hub = createFleetEventHub({ logger: { warn: vi.fn() } });
    const tenantId = randomUUID();
    const kept = vi.fn();
    const dropped = vi.fn();
    hub.subscribe(tenantId, kept);
    const cancel = hub.subscribe(tenantId, dropped);

    cancel();
    cancel();
    hub.publish(tenantId, stateEvent(vehicle(randomUUID(), 1)));

    expect(kept).toHaveBeenCalledOnce();
    expect(dropped).not.toHaveBeenCalled();
  });
});
