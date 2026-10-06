import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLoadWatchdog, createRenderScheduler } from "./render-scheduler";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("createRenderScheduler", () => {
  const setup = () => {
    const render = vi.fn();
    const scheduler = createRenderScheduler({ intervalMs: 500, tickMs: 30_000, render });
    return { render, scheduler };
  };

  it("ignora las peticiones antes de start (el mapa aún no cargó)", () => {
    const { render, scheduler } = setup();
    scheduler.request();
    vi.advanceTimersByTime(5_000);
    expect(render).not.toHaveBeenCalled();
  });

  it("start renderiza ya; 10 cambios en 500 ms son UNA sola llamada, al cumplirse el intervalo", () => {
    const { render, scheduler } = setup();
    vi.setSystemTime(10_000);
    scheduler.start();
    expect(render).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 10; i += 1) {
      vi.advanceTimersByTime(40);
      scheduler.request();
    }
    // 400 ms desde el último render: todavía no.
    expect(render).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(99);
    expect(render).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(render).toHaveBeenCalledTimes(2);
  });

  it("tras un rato sin cambios, el siguiente se renderiza sin esperar", () => {
    const { render, scheduler } = setup();
    scheduler.start();
    vi.advanceTimersByTime(5_000);
    scheduler.request();
    vi.advanceTimersByTime(0);
    expect(render).toHaveBeenCalledTimes(2);
  });

  it("cada 30 s renderiza aunque no haya cambios (el sin señal avanza con el tiempo)", () => {
    const { render, scheduler } = setup();
    scheduler.start();
    vi.advanceTimersByTime(29_999);
    expect(render).toHaveBeenCalledTimes(1);
    // En el tick se pide el render; como pasaron más de 500 ms desde el anterior, sale de inmediato.
    vi.advanceTimersByTime(2);
    expect(render).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(30_000);
    expect(render).toHaveBeenCalledTimes(3);
  });

  it("dispose cancela lo pendiente y el tick", () => {
    const { render, scheduler } = setup();
    scheduler.start();
    scheduler.request();
    scheduler.dispose();
    vi.advanceTimersByTime(120_000);
    expect(render).toHaveBeenCalledTimes(1);
  });
});

describe("createLoadWatchdog", () => {
  it("avisa a los 20 s si la capa no cargó", () => {
    const onTimeout = vi.fn();
    const watchdog = createLoadWatchdog({ timeoutMs: 20_000, onTimeout });
    watchdog.start();
    vi.advanceTimersByTime(19_999);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("no avisa si la capa cargó antes, ni tras dispose", () => {
    const loaded = vi.fn();
    const first = createLoadWatchdog({ timeoutMs: 20_000, onTimeout: loaded });
    first.start();
    first.markLoaded();
    const disposed = vi.fn();
    const second = createLoadWatchdog({ timeoutMs: 20_000, onTimeout: disposed });
    second.start();
    second.dispose();
    vi.advanceTimersByTime(60_000);
    expect(loaded).not.toHaveBeenCalled();
    expect(disposed).not.toHaveBeenCalled();
  });
});
