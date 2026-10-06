import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installGracefulShutdown, type GracefulShutdown, type ShutdownStep } from "./shutdown.js";

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

let installed: GracefulShutdown | undefined;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  installed?.dispose();
  installed = undefined;
  vi.useRealTimers();
});

function setup(steps: readonly ShutdownStep[], timeoutMs = 5_000) {
  const target = new EventEmitter();
  const exit = vi.fn();
  const log = logger();
  installed = installGracefulShutdown({ logger: log, steps, timeoutMs, exit, target });
  return { target, exit, log, shutdown: installed.shutdown };
}

describe("installGracefulShutdown", () => {
  it("corre los pasos en orden, de uno en uno, y sale con 0", async () => {
    const order: string[] = [];
    const step = (name: string, ms: number): ShutdownStep => ({
      name,
      run: async () => {
        order.push(`${name}:inicio`);
        await new Promise((resolve) => setTimeout(resolve, ms));
        order.push(`${name}:fin`);
      },
    });
    const { shutdown, exit } = setup([step("servidor", 100), step("productor", 50)]);

    const done = shutdown("test");
    await vi.advanceTimersByTimeAsync(200);

    expect(await done).toBe(0);
    expect(order).toEqual(["servidor:inicio", "servidor:fin", "productor:inicio", "productor:fin"]);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("si un paso falla lo registra, corre los siguientes y sale con 1", async () => {
    const closed = vi.fn().mockResolvedValue(undefined);
    const { shutdown, exit, log } = setup([
      { name: "servidor", run: () => Promise.reject(new Error("no cerró")) },
      { name: "pool", run: closed },
    ]);

    expect(await shutdown("test")).toBe(1);

    expect(closed).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ step: "servidor" }), expect.any(String));
  });

  it("fuerza la salida con 1 si el apagado supera su tope", async () => {
    const { shutdown, exit, log } = setup([{ name: "colgado", run: () => new Promise<void>(() => undefined) }], 3_000);

    const done = shutdown("test");
    await vi.advanceTimersByTimeAsync(3_000);

    expect(await done).toBe(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(log.error).toHaveBeenCalledWith({ timeoutMs: 3_000 }, expect.stringContaining("tope"));
  });

  it("es idempotente: una segunda señal espera el mismo apagado y no repite los pasos", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const { shutdown, exit } = setup([{ name: "uno", run }]);

    const [a, b] = await Promise.all([shutdown("SIGTERM"), shutdown("SIGINT")]);

    expect([a, b]).toEqual([0, 0]);
    expect(run).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
  });

  it("SIGTERM y SIGINT inician el apagado", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const { target, exit } = setup([{ name: "uno", run }]);

    target.emit("SIGTERM", "SIGTERM");
    await vi.advanceTimersByTimeAsync(0);

    expect(run).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("una promesa rechazada sin manejar o una excepción no controlada apagan con código 1", async () => {
    for (const event of ["unhandledRejection", "uncaughtException"]) {
      const run = vi.fn().mockResolvedValue(undefined);
      const { target, exit, log } = setup([{ name: "uno", run }]);

      target.emit(event, new Error("fallo"));
      await vi.advanceTimersByTimeAsync(0);

      expect(run).toHaveBeenCalledOnce();
      expect(exit).toHaveBeenCalledExactlyOnceWith(1);
      expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) as Error }), expect.stringContaining(event));
      installed?.dispose();
    }
  });

  it("dispose quita los manejadores", () => {
    const { target } = setup([]);

    installed?.dispose();

    expect(target.listenerCount("SIGTERM")).toBe(0);
    expect(target.listenerCount("SIGINT")).toBe(0);
    expect(target.listenerCount("unhandledRejection")).toBe(0);
    expect(target.listenerCount("uncaughtException")).toBe(0);
  });
});
