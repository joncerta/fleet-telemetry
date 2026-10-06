import { describe, expect, it } from "vitest";
import { createCredentialsStore, type TokenVault } from "./credentials";
import { MemoryOutboxStore } from "./memory-store";

const TOKEN = `fdt_${"A".repeat(43)}`;
const VEHICLE = "11111111-1111-4111-8111-111111111111";

function fakeVault() {
  let value: string | null = null;
  const vault: TokenVault = {
    get: () => Promise.resolve(value),
    set: (t) => {
      value = t;
      return Promise.resolve();
    },
    delete: () => {
      value = null;
      return Promise.resolve();
    },
  };
  return { vault, peek: () => value };
}

describe("createCredentialsStore", () => {
  it("el token va a la bóveda segura y el vehicleId a meta; get() los reúne", async () => {
    const meta = new MemoryOutboxStore();
    const { vault, peek } = fakeVault();
    const store = createCredentialsStore(vault, meta);
    await store.save({ token: TOKEN, vehicleId: VEHICLE });

    expect(peek()).toBe(TOKEN);
    expect(await meta.getMeta("vehicleId")).toBe(VEHICLE);
    expect(await store.get()).toEqual({ token: TOKEN, vehicleId: VEHICLE });
    expect(await store.getToken()).toBe(TOKEN);
  });

  it("acepta un token más largo o corto mientras empiece por fdt_ (opaco)", async () => {
    const store = createCredentialsStore(fakeVault().vault, new MemoryOutboxStore());
    await store.save({ token: "fdt_otroformato", vehicleId: VEHICLE });
    expect((await store.get())?.token).toBe("fdt_otroformato");
  });

  it("sin token o sin vehicleId el dispositivo no está vinculado", async () => {
    const meta = new MemoryOutboxStore();
    const { vault } = fakeVault();
    const store = createCredentialsStore(vault, meta);
    expect(await store.get()).toBeNull();
    await vault.set(TOKEN);
    expect(await store.get()).toBeNull();
    await meta.setMeta("vehicleId", "no-uuid");
    expect(await store.get()).toBeNull();
    expect(await store.getToken()).toBeNull();
  });

  it("clear() borra ambos", async () => {
    const meta = new MemoryOutboxStore();
    const { vault, peek } = fakeVault();
    const store = createCredentialsStore(vault, meta);
    await store.save({ token: TOKEN, vehicleId: VEHICLE });
    await store.clear();
    expect(peek()).toBeNull();
    expect(await meta.getMeta("vehicleId")).toBeNull();
    expect(await store.get()).toBeNull();
  });

  it("re-vincular reemplaza las credenciales", async () => {
    const store = createCredentialsStore(fakeVault().vault, new MemoryOutboxStore());
    await store.save({ token: TOKEN, vehicleId: VEHICLE });
    const other = "22222222-2222-4222-8222-222222222222";
    await store.save({ token: `fdt_${"B".repeat(43)}`, vehicleId: other });
    expect(await store.get()).toEqual({ token: `fdt_${"B".repeat(43)}`, vehicleId: other });
  });
});
