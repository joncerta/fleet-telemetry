import { describe, expect, it } from "vitest";
import { createAuthenticateDevice } from "../application/authenticate-device.js";
import { DeviceDirectoryUnavailableError } from "../application/errors.js";
import type { DeviceRepository } from "../application/ports.js";
import type { DeviceContext } from "../domain/device.js";
import { createCachedDeviceRepository } from "./cached-device-repository.js";
import { createLimitedDeviceRepository, DeviceLookupSaturatedError } from "./limited-device-repository.js";

const DEVICE: DeviceContext = {
  tenantId: "9d7e1b34-2a6c-4f08-b5d3-6e4a8c1f0b92",
  deviceId: "5b8a3f6c-1e9d-4a27-8c40-7f2e6d1b9a35",
  vehicleId: "a1c4e9d2-7b3f-4c58-8e16-0d9f2b6a4c71",
};
const TOKEN = "fdt_Zk3Qx9Wm2LpR7vTn4YbHc8DfJ1sAe6UoG0iNhXwVqKE";
const hashOf = (n: number) => String(n).padStart(64, "0");

/** Un repositorio interno cuyas consultas quedan en vuelo hasta que el test las libera. */
function holdingInner() {
  const calls: string[] = [];
  const pending: { release: () => void; fail: (error: Error) => void }[] = [];
  const inner: DeviceRepository = {
    findActiveByTokenHash(hash) {
      calls.push(hash);
      return new Promise<DeviceContext | null>((resolve, reject) => {
        pending.push({ release: () => resolve(DEVICE), fail: reject });
      });
    },
  };
  return { inner, calls, pending };
}

const cacheOptions = { ttlMs: 30_000, negativeTtlMs: 5_000, maxEntries: 100 };

describe("createLimitedDeviceRepository", () => {
  it("pasado el tope rechaza sin llamar al repositorio interno", async () => {
    const { inner, calls } = holdingInner();
    const limited = createLimitedDeviceRepository(inner, { maxInFlight: 2 });

    void limited.findActiveByTokenHash(hashOf(1));
    void limited.findActiveByTokenHash(hashOf(2));
    await expect(limited.findActiveByTokenHash(hashOf(3))).rejects.toBeInstanceOf(DeviceLookupSaturatedError);

    expect(calls).toEqual([hashOf(1), hashOf(2)]);
  });

  it("al terminar una consulta (bien o mal) libera su cupo", async () => {
    const { inner, calls, pending } = holdingInner();
    const limited = createLimitedDeviceRepository(inner, { maxInFlight: 1 });

    const first = limited.findActiveByTokenHash(hashOf(1));
    pending[0]?.release();
    await expect(first).resolves.toEqual(DEVICE);

    const second = limited.findActiveByTokenHash(hashOf(2));
    pending[1]?.fail(new Error("boom"));
    await expect(second).rejects.toThrow("boom");

    const third = limited.findActiveByTokenHash(hashOf(3));
    pending[2]?.release();
    await expect(third).resolves.toEqual(DEVICE);
    expect(calls).toHaveLength(3);
  });

  it("un fallo síncrono del repositorio interno también libera el cupo", async () => {
    const inner: DeviceRepository = {
      findActiveByTokenHash() {
        throw new Error("síncrono");
      },
    };
    const limited = createLimitedDeviceRepository(inner, { maxInFlight: 1 });

    await expect(limited.findActiveByTokenHash(hashOf(1))).rejects.toThrow("síncrono");
    await expect(limited.findActiveByTokenHash(hashOf(2))).rejects.toThrow("síncrono");
  });

  it("debajo de la caché los aciertos no cuentan: con el tope lleno, un token en caché sigue autenticando", async () => {
    const { inner, calls, pending } = holdingInner();
    const cached = createCachedDeviceRepository(createLimitedDeviceRepository(inner, { maxInFlight: 1 }), cacheOptions);

    const warm = cached.findActiveByTokenHash(hashOf(1));
    pending[0]?.release();
    await warm;

    // Una consulta de otro token ocupa el único cupo.
    void cached.findActiveByTokenHash(hashOf(2));
    await expect(cached.findActiveByTokenHash(hashOf(1))).resolves.toEqual(DEVICE);
    await expect(cached.findActiveByTokenHash(hashOf(3))).rejects.toBeInstanceOf(DeviceLookupSaturatedError);

    expect(calls).toEqual([hashOf(1), hashOf(2)]);
  });

  it("un rechazo por saturación no se guarda en la caché negativa: al liberarse el cupo se vuelve a consultar", async () => {
    const { inner, calls, pending } = holdingInner();
    const cached = createCachedDeviceRepository(createLimitedDeviceRepository(inner, { maxInFlight: 1 }), cacheOptions);

    const occupying = cached.findActiveByTokenHash(hashOf(1));
    await expect(cached.findActiveByTokenHash(hashOf(2))).rejects.toBeInstanceOf(DeviceLookupSaturatedError);
    pending[0]?.release();
    await occupying;

    const retry = cached.findActiveByTokenHash(hashOf(2));
    pending[1]?.release();
    await expect(retry).resolves.toEqual(DEVICE);
    expect(calls).toEqual([hashOf(1), hashOf(2)]);
  });

  it("el caso de uso lo traduce a DeviceDirectoryUnavailableError (503), no a null (401), y sin tocar el repositorio interno", async () => {
    const { inner, calls } = holdingInner();
    const limited = createLimitedDeviceRepository(inner, { maxInFlight: 1 });
    const first = createAuthenticateDevice({ devices: limited, hashToken: () => hashOf(1) });
    const second = createAuthenticateDevice({ devices: limited, hashToken: () => hashOf(2) });

    void first(TOKEN); // ocupa el único cupo

    await expect(second(TOKEN)).rejects.toBeInstanceOf(DeviceDirectoryUnavailableError);
    expect(calls).toEqual([hashOf(1)]);
  });

  it("exige un tope entero positivo", () => {
    const { inner } = holdingInner();
    expect(() => createLimitedDeviceRepository(inner, { maxInFlight: 0 })).toThrow(RangeError);
    expect(() => createLimitedDeviceRepository(inner, { maxInFlight: 1.5 })).toThrow(RangeError);
  });
});
