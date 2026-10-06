import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabaseCheck } from "./readiness.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createDatabaseCheck", () => {
  it("es true cuando SELECT 1 responde", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const warn = vi.fn();

    await expect(createDatabaseCheck({ query }, { warn }).check()).resolves.toBe(true);

    expect(query).toHaveBeenCalledWith("SELECT 1");
    expect(warn).not.toHaveBeenCalled();
  });

  it("es false y deja el error en el log (no en el resultado) si la base falla", async () => {
    const warn = vi.fn();
    const failure = new Error("connect ECONNREFUSED 127.0.0.1:5432");

    const up = await createDatabaseCheck({ query: () => Promise.reject(failure) }, { warn }).check();

    expect(up).toBe(false);
    expect(warn).toHaveBeenCalledWith({ err: failure }, expect.any(String));
  });

  it("es false si la base no responde dentro del tope, y no deja temporizadores colgados", async () => {
    const warn = vi.fn();
    const check = createDatabaseCheck({ query: () => new Promise(() => undefined) }, { warn }, 2_000);

    const result = check.check();
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(result).resolves.toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancela el temporizador cuando la base responde a tiempo", async () => {
    await createDatabaseCheck({ query: () => Promise.resolve({}) }, { warn: vi.fn() }).check();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("se llama database", () => {
    expect(createDatabaseCheck({ query: vi.fn() }, { warn: vi.fn() }).name).toBe("database");
  });
});
