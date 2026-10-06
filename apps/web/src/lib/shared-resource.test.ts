import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSharedResource } from "./shared-resource";

function setup(delayMs = 50) {
  const instances: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }[] = [];
  const resource = createSharedResource(() => {
    const instance = { start: vi.fn(), stop: vi.fn() };
    instances.push(instance);
    return instance;
  }, delayMs);
  return { resource, instances };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("createSharedResource", () => {
  it("dos titulares comparten UNA instancia, que se detiene cuando el último la suelta", () => {
    const { resource, instances } = setup();
    const releaseA = resource.acquire();
    const releaseB = resource.acquire();
    expect(instances).toHaveLength(1);
    expect(instances[0]?.start).toHaveBeenCalledTimes(1);

    releaseA();
    vi.advanceTimersByTime(100);
    expect(instances[0]?.stop).not.toHaveBeenCalled();
    releaseB();
    vi.advanceTimersByTime(50);
    expect(instances[0]?.stop).toHaveBeenCalledTimes(1);
  });

  it("el doble montaje de StrictMode (montar, desmontar, montar) no cierra ni abre otra conexión", () => {
    const { resource, instances } = setup();
    const release = resource.acquire();
    release();
    resource.acquire();
    vi.advanceTimersByTime(1_000);
    expect(instances).toHaveLength(1);
    expect(instances[0]?.stop).not.toHaveBeenCalled();
  });

  it("soltar dos veces no descuenta a otro titular", () => {
    const { resource, instances } = setup();
    const releaseA = resource.acquire();
    resource.acquire();
    releaseA();
    releaseA();
    vi.advanceTimersByTime(1_000);
    expect(instances[0]?.stop).not.toHaveBeenCalled();
  });

  it("dispose detiene ya; un release tardío no afecta a la instancia siguiente", () => {
    const { resource, instances } = setup();
    const stale = resource.acquire();
    resource.dispose();
    expect(instances[0]?.stop).toHaveBeenCalledTimes(1);

    resource.acquire();
    stale();
    vi.advanceTimersByTime(1_000);
    expect(instances).toHaveLength(2);
    expect(instances[1]?.stop).not.toHaveBeenCalled();
  });
});
