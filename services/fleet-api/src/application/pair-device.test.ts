import { randomUUID } from "node:crypto";
import { devicePairResponseSchema } from "@fleet/contracts";
import { describe, expect, it, vi } from "vitest";
import { InvalidPairingCodeError, PairingInconsistencyError } from "./errors.js";
import { createPairDevice } from "./pair-device.js";
import type { PairingCredentials, PairingTransaction, PairingUnitOfWork } from "./ports.js";

const tenantId = randomUUID();
const vehicleId = randomUUID();
const deviceId = randomUUID();
const TOKEN = "fdt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const PAIRED_AT = new Date("2026-10-06T12:00:00.000Z");

const credentials: PairingCredentials = { newPairingCode: vi.fn(), newDeviceToken: () => TOKEN, newDeviceId: () => deviceId };
const hash = (value: string) => `hash(${value})`;

/** Transacción falsa que anota el orden de las operaciones. Cada operación es un `vi.fn` aparte, para poder afirmar sobre ella. */
function makeTransaction(overrides: Partial<PairingTransaction> = {}) {
  const order: string[] = [];
  const consumeCode = vi.fn<PairingTransaction["consumeCode"]>(() => {
    order.push("consumeCode");
    return Promise.resolve({ tenantId, vehicleId });
  });
  const lockVehicle = vi.fn<PairingTransaction["lockVehicle"]>(() => {
    order.push("lockVehicle");
    return Promise.resolve({ plate: "ABC123" });
  });
  const revokeActiveDevices = vi.fn<PairingTransaction["revokeActiveDevices"]>(() => {
    order.push("revokeActiveDevices");
    return Promise.resolve();
  });
  const insertDevice = vi.fn<PairingTransaction["insertDevice"]>(() => {
    order.push("insertDevice");
    return Promise.resolve({ createdAt: PAIRED_AT });
  });
  const transaction: PairingTransaction = { consumeCode, lockVehicle, revokeActiveDevices, insertDevice, ...overrides };
  return { order, transaction, consumeCode, lockVehicle, revokeActiveDevices, insertDevice };
}

/** Unidad de trabajo falsa: como la real, propaga el resultado y deja pasar el error (que revertiría la transacción). */
const unitOfWorkOf = (transaction: PairingTransaction): PairingUnitOfWork => ({ run: (work) => work(transaction) });

describe("createPairDevice", () => {
  it("canjea el código, revoca el dispositivo activo y crea el nuevo, en ese orden, y devuelve el token UNA vez", async () => {
    const { order, transaction } = makeTransaction();

    const result = await createPairDevice({ unitOfWork: unitOfWorkOf(transaction), credentials, hash })({ code: "K7M2QX9P" });

    expect(order).toEqual(["consumeCode", "lockVehicle", "revokeActiveDevices", "insertDevice"]);
    expect(devicePairResponseSchema.parse(result.response)).toEqual({ deviceToken: TOKEN, vehicleId, plate: "ABC123", pairedAt: "2026-10-06T12:00:00.000Z" });
    expect(result).toMatchObject({ tenantId, deviceId });
  });

  it("busca el código por su hash y guarda el hash del token, nunca el token ni el código en claro", async () => {
    const { transaction, consumeCode, insertDevice } = makeTransaction();

    await createPairDevice({ unitOfWork: unitOfWorkOf(transaction), credentials, hash })({ code: "K7M2QX9P" });

    expect(consumeCode).toHaveBeenCalledExactlyOnceWith("hash(K7M2QX9P)");
    expect(insertDevice).toHaveBeenCalledExactlyOnceWith({ deviceId, tenantId, vehicleId, tokenHash: `hash(${TOKEN})` });
    expect(JSON.stringify(insertDevice.mock.calls)).not.toContain(`"${TOKEN}"`);
  });

  it("revoca y bloquea con el tenant del CÓDIGO, no con nada que venga del cliente", async () => {
    const { transaction, lockVehicle, revokeActiveDevices } = makeTransaction();

    await createPairDevice({ unitOfWork: unitOfWorkOf(transaction), credentials, hash })({ code: "K7M2QX9P" });

    expect(lockVehicle).toHaveBeenCalledExactlyOnceWith(tenantId, vehicleId);
    expect(revokeActiveDevices).toHaveBeenCalledExactlyOnceWith(tenantId, vehicleId);
  });

  it("un código inválido, usado o vencido (consumeCode da null) es InvalidPairingCodeError y no toca dispositivos", async () => {
    const { order, transaction } = makeTransaction({ consumeCode: () => Promise.resolve(null) });

    await expect(createPairDevice({ unitOfWork: unitOfWorkOf(transaction), credentials, hash })({ code: "K7M2QX9P" })).rejects.toBeInstanceOf(InvalidPairingCodeError);

    expect(order).toEqual([]);
  });

  it("si crear el dispositivo falla, el error sube (la unidad de trabajo revierte: el código sigue valiendo)", async () => {
    const { transaction } = makeTransaction({ insertDevice: () => Promise.reject(new Error("unique violation")) });

    await expect(createPairDevice({ unitOfWork: unitOfWorkOf(transaction), credentials, hash })({ code: "K7M2QX9P" })).rejects.toThrow("unique violation");
  });

  it("un vehículo ausente tras un código vigente es una invariante rota (500), no un código inválido", async () => {
    const { transaction } = makeTransaction({ lockVehicle: () => Promise.resolve(null) });

    await expect(createPairDevice({ unitOfWork: unitOfWorkOf(transaction), credentials, hash })({ code: "K7M2QX9P" })).rejects.toBeInstanceOf(PairingInconsistencyError);
  });
});
