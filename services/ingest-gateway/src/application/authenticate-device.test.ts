import { describe, expect, it } from "vitest";
import type { DeviceContext } from "../domain/device.js";
import { createAuthenticateDevice } from "./authenticate-device.js";
import { DeviceDirectoryUnavailableError } from "./errors.js";
import type { DeviceRepository } from "./ports.js";

const TOKEN = "fdt_Zk3Qx9Wm2LpR7vTn4YbHc8DfJ1sAe6UoG0iNhXwVqKE";
const DEVICE: DeviceContext = {
  tenantId: "9d7e1b34-2a6c-4f08-b5d3-6e4a8c1f0b92",
  deviceId: "5b8a3f6c-1e9d-4a27-8c40-7f2e6d1b9a35",
  vehicleId: "a1c4e9d2-7b3f-4c58-8e16-0d9f2b6a4c71",
};

/** Hash falso y reversible a la vista: el caso de uso no debe conocer el algoritmo. */
const hashToken = (token: string) => `hash(${token})`;

function setup(registered: Record<string, DeviceContext | null> = { [hashToken(TOKEN)]: DEVICE }) {
  const lookups: string[] = [];
  const devices: DeviceRepository = {
    findActiveByTokenHash: (hash) => {
      lookups.push(hash);
      return Promise.resolve(registered[hash] ?? null);
    },
  };
  return { lookups, authenticate: createAuthenticateDevice({ devices, hashToken }) };
}

describe("authenticateDevice", () => {
  it("devuelve la identidad del dispositivo y busca por el hash del token, nunca por el token en claro", async () => {
    const { authenticate, lookups } = setup();

    await expect(authenticate(TOKEN)).resolves.toEqual(DEVICE);

    expect(lookups).toEqual([hashToken(TOKEN)]);
    expect(lookups.join()).not.toBe(TOKEN);
  });

  it("un token desconocido o revocado (el repositorio no lo encuentra) es null", async () => {
    const { authenticate } = setup({});

    await expect(authenticate(TOKEN)).resolves.toBeNull();
  });

  it.each([
    ["ausente", undefined],
    ["vacío", ""],
    ["sin el prefijo fdt_", "Zk3Qx9Wm2LpR7vTn4YbHc8DfJ1sAe6UoG0iNhXwVqKE"],
    ["demasiado corto", "fdt_corto"],
    ["con caracteres fuera de base64url", "fdt_Zk3Qx9Wm2LpR7vTn4YbHc8DfJ1sAe6UoG0iNhXwVq+/"],
    ["demasiado largo", `${TOKEN}A`],
  ])("un token %s es null sin consultar el repositorio", async (_label, token) => {
    const { authenticate, lookups } = setup();

    await expect(authenticate(token)).resolves.toBeNull();

    expect(lookups).toEqual([]);
  });

  it("un fallo del repositorio es DeviceDirectoryUnavailableError (con el error original como causa): no se confunde con 'token desconocido'", async () => {
    const failure = new Error("la base no responde");
    const authenticate = createAuthenticateDevice({
      devices: { findActiveByTokenHash: () => Promise.reject(failure) },
      hashToken,
    });

    const error = await authenticate(TOKEN).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DeviceDirectoryUnavailableError);
    expect(error).toMatchObject({ cause: failure });
  });

  it("el mensaje del error no incluye el del repositorio (que puede traer SQL o direcciones)", async () => {
    const authenticate = createAuthenticateDevice({
      devices: { findActiveByTokenHash: () => Promise.reject(new Error("connect ECONNREFUSED 10.0.0.5:5432")) },
      hashToken,
    });

    const error = await authenticate(TOKEN).catch((caught: unknown) => caught);

    expect(error instanceof Error ? error.message : "").not.toMatch(/10.0.0.5|ECONNREFUSED/);
  });

  it("un token mal formado no llega a la base, así que no puede dar DeviceDirectoryUnavailableError", async () => {
    const authenticate = createAuthenticateDevice({
      devices: { findActiveByTokenHash: () => Promise.reject(new Error("la base no responde")) },
      hashToken,
    });

    await expect(authenticate("fdt_corto")).resolves.toBeNull();
  });
});
