import { describe, expect, it, vi } from "vitest";
import type { BatchHandler, TelemetryBatchPayload } from "./telemetry-batch-handler.js";
import { createTelemetryConsumerRunner, type ConsumerEvent, type ConsumerPort } from "./telemetry-consumer.js";

const EVENTS = {
  GROUP_JOIN: "consumer.group_join",
  REBALANCING: "consumer.rebalancing",
  CRASH: "consumer.crash",
  START_BATCH_PROCESS: "consumer.start_batch_process",
} as const;

function fakeConsumer() {
  const calls: string[] = [];
  const listeners = new Map<string, (event: ConsumerEvent) => void>();
  const step = (name: string) =>
    vi.fn(() => {
      calls.push(name);
      return Promise.resolve();
    });
  const consumer = {
    events: EVENTS,
    on: vi.fn((event: string, listener: (event: ConsumerEvent) => void) => {
      listeners.set(event, listener);
    }),
    connect: step("connect"),
    subscribe: vi.fn((_subscription: { topic: string; fromBeginning: boolean }) => {
      calls.push("subscribe");
      return Promise.resolve();
    }),
    run: vi.fn((_config: { autoCommit: boolean; eachBatchAutoResolve: boolean; eachBatch: BatchHandler }) => {
      calls.push("run");
      return Promise.resolve();
    }),
    stop: step("stop"),
    disconnect: step("disconnect"),
  } satisfies ConsumerPort;
  return { consumer, calls, listeners };
}

const logger = () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() });

/** Cualquier `Error`, como `unknown` (`expect.any` devuelve `any`, que el lint no deja anidar en un objeto). */
const anError: unknown = expect.any(Error);

function runnerWith(handler = vi.fn().mockResolvedValue(undefined)) {
  const fake = fakeConsumer();
  const log = logger();
  const onFatal = vi.fn<(reason: string) => void>();
  const runner = createTelemetryConsumerRunner({ consumer: fake.consumer, topic: "telemetry.raw", groupId: "processor-test", handler, logger: log, onFatal });
  return { ...fake, runner, log, handler, onFatal };
}

const crash = (restart: boolean): ConsumerEvent => ({
  type: "consumer.crash",
  payload: { error: new Error("el consumer se cayó"), groupId: "processor-test", restart },
});

describe("createTelemetryConsumerRunner", () => {
  it("conecta, se suscribe a telemetry.raw desde el principio y consume por lotes sin resolver offsets automáticamente", async () => {
    const { runner, consumer, calls, handler } = runnerWith();

    await runner.start();

    expect(calls).toEqual(["connect", "subscribe", "run"]);
    expect(consumer.subscribe).toHaveBeenCalledWith({ topic: "telemetry.raw", fromBeginning: true });
    // autoCommit confirma solo lo que el caso de uso resolvió; la auto-resolución del último offset del lote queda apagada.
    expect(consumer.run).toHaveBeenCalledWith({ autoCommit: true, eachBatchAutoResolve: false, eachBatch: handler });
  });

  it("delega cada lote en el handler que recibe (no decide nada por su cuenta)", async () => {
    const { runner, consumer, handler } = runnerWith();
    await runner.start();
    const eachBatch = consumer.run.mock.calls[0]?.[0].eachBatch;

    const payload: TelemetryBatchPayload = {
      batch: { topic: "telemetry.raw", partition: 2, messages: [{ offset: "7", key: null, value: null }] },
      resolveOffset: vi.fn(),
      heartbeat: () => Promise.resolve(),
      commitOffsetsIfNecessary: () => Promise.resolve(),
      isRunning: () => true,
      isStale: () => false,
    };
    await eachBatch?.(payload);

    expect(handler).toHaveBeenCalledExactlyOnceWith(payload);
  });

  it("si el handler falla, el error llega a kafkajs (que no confirma lo no resuelto y reentrega)", async () => {
    const { runner, consumer } = runnerWith(vi.fn().mockRejectedValue(new Error("base caída")));
    await runner.start();
    const eachBatch = consumer.run.mock.calls[0]?.[0].eachBatch;

    await expect(
      eachBatch?.({
        batch: { topic: "telemetry.raw", partition: 0, messages: [] },
        resolveOffset: vi.fn(),
        heartbeat: () => Promise.resolve(),
        commitOffsetsIfNecessary: () => Promise.resolve(),
        isRunning: () => true,
        isStale: () => false,
      }),
    ).rejects.toThrow("base caída");
  });

  it("al detenerse deja de consumir antes de desconectar", async () => {
    const { runner, calls } = runnerWith();
    await runner.start();

    await runner.stop();

    expect(calls.slice(-2)).toEqual(["stop", "disconnect"]);
  });

  it("si stop falla no se traga el error (el apagado ordenado lo registra)", async () => {
    const { runner, consumer } = runnerWith();
    consumer.stop.mockRejectedValueOnce(new Error("no paró"));

    await expect(runner.stop()).rejects.toThrow("no paró");
  });

  it("si la conexión falla, start propaga el error y no llega a consumir", async () => {
    const { runner, consumer } = runnerWith();
    consumer.connect.mockRejectedValueOnce(new Error("broker caído"));

    await expect(runner.start()).rejects.toThrow("broker caído");

    expect(consumer.run).not.toHaveBeenCalled();
  });

  it("registra al unirse al grupo (grupo y particiones, nada del contenido)", async () => {
    const { runner, listeners, log } = runnerWith();
    await runner.start();

    listeners.get(EVENTS.GROUP_JOIN)?.({ type: "consumer.group_join", payload: { memberAssignment: { "telemetry.raw": [0, 1, 2] } } });

    expect(log.info).toHaveBeenCalledWith({ groupId: "processor-test", partitions: [0, 1, 2] }, "Consumer unido al grupo");
  });

  describe("CRASH: un consumer caído sin reinicio deja un proceso vivo que no consume", () => {
    it("con restart: false registra el error y llama a onFatal para que el orquestador reinicie el proceso", async () => {
      const { runner, listeners, log, onFatal } = runnerWith();
      await runner.start();

      listeners.get(EVENTS.CRASH)?.(crash(false));

      expect(log.error).toHaveBeenCalledTimes(1);
      expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ groupId: "processor-test", err: anError }), expect.any(String));
      expect(onFatal).toHaveBeenCalledOnce();
      expect(onFatal).toHaveBeenCalledWith(expect.stringMatching(/consumer/i));
    });

    it("con restart: true kafkajs ya lo reinicia: solo se avisa (warn), sin apagar el proceso", async () => {
      const { runner, listeners, log, onFatal } = runnerWith();
      await runner.start();

      listeners.get(EVENTS.CRASH)?.(crash(true));

      expect(onFatal).not.toHaveBeenCalled();
      expect(log.error).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ groupId: "processor-test", err: anError }), expect.any(String));
    });

    // Falla en cerrado: sin poder leer el payload no se sabe si kafkajs reinicia el consumer; es preferible reiniciar el proceso. Aquí
    // `restart: true` viene en un payload que no cumple el esquema (error como texto, sin groupId): igual se llama a onFatal.
    it.each([
      ["error como texto y sin groupId", { error: "texto", restart: true }],
      ["sin restart", { error: new Error("el consumer se cayó"), groupId: "processor-test" }],
      ["restart que no es booleano", { error: new Error("el consumer se cayó"), groupId: "processor-test", restart: "true" }],
      ["sin payload", undefined],
    ])("con un payload ilegible (%s) llama a onFatal y registra el error, sin filtrar el payload", async (_label, payload) => {
      const { runner, listeners, log, onFatal } = runnerWith();
      await runner.start();

      listeners.get(EVENTS.CRASH)?.({ type: "consumer.crash", payload });

      expect(onFatal).toHaveBeenCalledOnce();
      expect(log.error).toHaveBeenCalledTimes(1);
      expect(log.warn).not.toHaveBeenCalled();
      expect(JSON.stringify(vi.mocked(log.error).mock.calls)).not.toContain("texto");
    });

    it("ignora los eventos de otro tipo que lleguen al listener del CRASH", async () => {
      const { runner, listeners, onFatal } = runnerWith();
      await runner.start();

      listeners.get(EVENTS.CRASH)?.({ type: "consumer.group_join", payload: { memberAssignment: {} } });

      expect(onFatal).not.toHaveBeenCalled();
    });

    it("el listener se registra al arrancar, antes de conectar", async () => {
      const { runner, consumer, calls } = runnerWith();

      await runner.start();

      expect(consumer.on).toHaveBeenCalledWith(EVENTS.CRASH, expect.any(Function));
      expect(calls[0]).toBe("connect");
      expect(consumer.on.mock.invocationCallOrder[0]).toBeLessThan(consumer.connect.mock.invocationCallOrder[0] ?? 0);
    });
  });

  describe("lag por partición", () => {
    it("registra el lag de cada lote en debug (partición, lag y tamaño), sin contenido de mensajes", async () => {
      const { runner, listeners, log } = runnerWith();
      await runner.start();

      listeners.get(EVENTS.START_BATCH_PROCESS)?.({
        type: "consumer.start_batch_process",
        payload: { topic: "telemetry.raw", partition: 3, highWatermark: "1500", offsetLag: "1200", offsetLagLow: "1300", batchSize: 100 },
      });

      expect(log.debug).toHaveBeenCalledWith(
        { groupId: "processor-test", topic: "telemetry.raw", partition: 3, offsetLag: "1200", batchSize: 100 },
        expect.any(String),
      );
    });

    it("ignora los eventos de otro tipo", async () => {
      const { runner, listeners, log } = runnerWith();
      await runner.start();

      listeners.get(EVENTS.START_BATCH_PROCESS)?.(crash(true));

      expect(log.debug).not.toHaveBeenCalled();
    });
  });
});
