import { randomUUID } from "node:crypto";
import { pairingCodeSchema, PAIRING_CODE_ALPHABET } from "@fleet/contracts";
import { describe, expect, it, vi } from "vitest";
import { createCreatePairingCode } from "./create-pairing-code.js";
import { PairingInconsistencyError, VehicleNotFoundError } from "./errors.js";
import type { CreatePairingCodeResult, PairingCodeRepository, PairingCredentials } from "./ports.js";

const identity = { userId: randomUUID(), tenantId: randomUUID() };
const vehicleId = randomUUID();
const EXPIRES = new Date("2026-10-06T12:10:00.000Z");

const hashOf = (value: string) => `hash(${value})`;

function makeUseCase(results: CreatePairingCodeResult[], codes = ["K7M2QX9P", "AAAAAAAA", "BBBBBBBB"]) {
  const queue = [...results];
  const create = vi.fn<PairingCodeRepository["create"]>().mockImplementation(() => Promise.resolve(queue.shift() ?? { status: "code_collision" }));
  const remaining = [...codes];
  const credentials: PairingCredentials = {
    newPairingCode: () => remaining.shift() ?? "ZZZZZZZZ",
    newDeviceToken: vi.fn(),
    newDeviceId: vi.fn(),
  };
  return { create, createCode: createCreatePairingCode({ codes: { create }, credentials, hash: hashOf, ttlMinutes: 10 }) };
}

describe("createCreatePairingCode", () => {
  it("crea el código para el vehículo del tenant de la sesión, guarda solo su hash y devuelve el código en claro una vez", async () => {
    const { create, createCode } = makeUseCase([{ status: "created", expiresAt: EXPIRES }]);

    const result = await createCode({ identity, vehicleId });

    expect(pairingCodeSchema.parse(result)).toEqual({ code: "K7M2QX9P", vehicleId, expiresAt: "2026-10-06T12:10:00.000Z" });
    expect(create).toHaveBeenCalledExactlyOnceWith({
      tenantId: identity.tenantId,
      vehicleId,
      createdBy: identity.userId,
      codeHash: "hash(K7M2QX9P)",
      ttlMinutes: 10,
    });
    expect(JSON.stringify(create.mock.calls)).not.toContain('"K7M2QX9P"');
  });

  it("un vehículo ajeno o inexistente es VehicleNotFoundError y no reintenta", async () => {
    const { create, createCode } = makeUseCase([{ status: "vehicle_not_found" }]);

    await expect(createCode({ identity, vehicleId })).rejects.toBeInstanceOf(VehicleNotFoundError);

    expect(create).toHaveBeenCalledOnce();
  });

  it("ante una colisión del hash genera otro código y reintenta", async () => {
    const { create, createCode } = makeUseCase([{ status: "code_collision" }, { status: "created", expiresAt: EXPIRES }]);

    const result = await createCode({ identity, vehicleId });

    expect(result.code).toBe("AAAAAAAA");
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("si todos los intentos colisionan falla como error de servidor, no como un código inválido", async () => {
    const { create, createCode } = makeUseCase([{ status: "code_collision" }, { status: "code_collision" }, { status: "code_collision" }]);

    await expect(createCode({ identity, vehicleId })).rejects.toBeInstanceOf(PairingInconsistencyError);

    expect(create).toHaveBeenCalledTimes(3);
  });

  it("un fallo de la base se propaga", async () => {
    const credentials: PairingCredentials = { newPairingCode: () => "K7M2QX9P", newDeviceToken: vi.fn(), newDeviceId: vi.fn() };
    const createCode = createCreatePairingCode({ codes: { create: () => Promise.reject(new Error("boom")) }, credentials, hash: hashOf, ttlMinutes: 10 });

    await expect(createCode({ identity, vehicleId })).rejects.toThrow("boom");
  });

  it("los códigos de prueba usan el alfabeto del contrato (sanidad del fixture)", () => {
    expect([..."K7M2QX9P"].every((char) => PAIRING_CODE_ALPHABET.includes(char))).toBe(true);
  });
});
