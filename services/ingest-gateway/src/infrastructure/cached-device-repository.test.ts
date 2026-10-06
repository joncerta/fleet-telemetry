import { describe, expect, it } from "vitest";
import type { DeviceRepository } from "../application/ports.js";
import type { DeviceContext } from "../domain/device.js";
import { createCachedDeviceRepository } from "./cached-device-repository.js";

const DEVICE: DeviceContext = {
  tenantId: "9d7e1b34-2a6c-4f08-b5d3-6e4a8c1f0b92",
  deviceId: "5b8a3f6c-1e9d-4a27-8c40-7f2e6d1b9a35",
  vehicleId: "a1c4e9d2-7b3f-4c58-8e16-0d9f2b6a4c71",
};
const HASH = "a".repeat(64);

function setup(options: { ttlMs?: number; negativeTtlMs?: number; maxEntries?: number } = {}) {
  let now = 0;
  const registry = new Map<string, DeviceContext>([[HASH, DEVICE]]);
  const calls: string[] = [];
  let failure: Error | undefined;
  let gate: Promise<void> | undefined;
  const inner: DeviceRepository = {
    async findActiveByTokenHash(hash) {
      calls.push(hash);
      if (gate) await gate;
      if (failure) throw failure;
      return registry.get(hash) ?? null;
    },
  };
  const cached = createCachedDeviceRepository(inner, {
    ttlMs: options.ttlMs ?? 30_000,
    negativeTtlMs: options.negativeTtlMs ?? 5_000,
    maxEntries: options.maxEntries ?? 100,
    now: () => now,
  });
  return {
    cached,
    calls,
    registry,
    advance: (ms: number) => void (now += ms),
    failWith: (error: Error | undefined) => void (failure = error),
    holdLookups: () => {
      let release: () => void = () => undefined;
      gate = new Promise<void>((resolve) => void (release = resolve));
      return () => {
        gate = undefined;
        release();
      };
    },
  };
}

describe("createCachedDeviceRepository", () => {
  it("la segunda búsqueda del mismo token sale de la caché, sin tocar el repositorio", async () => {
    const { cached, calls } = setup();

    await expect(cached.findActiveByTokenHash(HASH)).resolves.toEqual(DEVICE);
    await expect(cached.findActiveByTokenHash(HASH)).resolves.toEqual(DEVICE);

    expect(calls).toEqual([HASH]);
  });

  it("la revocación se aplica como máximo al vencer el TTL: antes sigue entrando, después ya no", async () => {
    const { cached, registry, advance, calls } = setup({ ttlMs: 30_000 });
    await cached.findActiveByTokenHash(HASH);

    registry.delete(HASH); // revocado en la base
    advance(29_999);
    await expect(cached.findActiveByTokenHash(HASH)).resolves.toEqual(DEVICE);
    advance(1);
    await expect(cached.findActiveByTokenHash(HASH)).resolves.toBeNull();

    expect(calls).toHaveLength(2);
  });

  it("un token desconocido se recuerda con el TTL negativo, más corto, y luego se vuelve a consultar", async () => {
    const { cached, registry, advance, calls } = setup({ ttlMs: 30_000, negativeTtlMs: 5_000 });
    const other = "b".repeat(64);

    await expect(cached.findActiveByTokenHash(other)).resolves.toBeNull();
    registry.set(other, DEVICE); // el dispositivo se crea después
    advance(4_999);
    await expect(cached.findActiveByTokenHash(other)).resolves.toBeNull();
    expect(calls).toEqual([other]);

    advance(1);
    await expect(cached.findActiveByTokenHash(other)).resolves.toEqual(DEVICE);
    expect(calls).toEqual([other, other]);
  });

  it("probar muchos tokens desconocidos no expulsa a un dispositivo legítimo de la caché de aciertos", async () => {
    const { cached, calls } = setup({ maxEntries: 3 });
    await cached.findActiveByTokenHash(HASH);

    for (let i = 0; i < 50; i++) await cached.findActiveByTokenHash(i.toString(16).padStart(64, "0"));
    calls.length = 0;
    await expect(cached.findActiveByTokenHash(HASH)).resolves.toEqual(DEVICE);

    expect(calls).toEqual([]);
  });

  it("peticiones simultáneas con el mismo token comparten una sola consulta", async () => {
    const { cached, calls, holdLookups } = setup();
    const release = holdLookups();

    const pending = Promise.all([cached.findActiveByTokenHash(HASH), cached.findActiveByTokenHash(HASH), cached.findActiveByTokenHash(HASH)]);
    release();

    await expect(pending).resolves.toEqual([DEVICE, DEVICE, DEVICE]);
    expect(calls).toEqual([HASH]);
  });

  it("un error del repositorio se propaga y NO se guarda: la siguiente búsqueda reintenta", async () => {
    const { cached, calls, failWith } = setup();
    failWith(new Error("la base no responde"));

    await expect(cached.findActiveByTokenHash(HASH)).rejects.toThrow("la base no responde");
    failWith(undefined);
    await expect(cached.findActiveByTokenHash(HASH)).resolves.toEqual(DEVICE);

    expect(calls).toEqual([HASH, HASH]);
  });

  it("con TTL 0 no cachea: cada búsqueda va al repositorio", async () => {
    const { cached, calls } = setup({ ttlMs: 0, negativeTtlMs: 0 });

    await cached.findActiveByTokenHash(HASH);
    await cached.findActiveByTokenHash(HASH);

    expect(calls).toHaveLength(2);
  });
});
