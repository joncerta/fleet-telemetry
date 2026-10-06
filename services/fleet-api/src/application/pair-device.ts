import type { DevicePairRequest, DevicePairResponse } from "@fleet/contracts";
import { InvalidPairingCodeError, PairingInconsistencyError } from "./errors.js";
import type { PairingCredentials, PairingUnitOfWork } from "./ports.js";

export interface PairDeviceDependencies {
  unitOfWork: PairingUnitOfWork;
  credentials: PairingCredentials;
  /** sha256 hexadecimal minúscula (`sha256Hex`): lo único del código y del token que se guarda. */
  hash: (value: string) => string;
}

export interface PairDeviceResult {
  response: DevicePairResponse;
  /** Para el log del llamador (identificadores, nunca el código ni el token). */
  tenantId: string;
  deviceId: string;
}

export type PairDevice = (request: DevicePairRequest) => Promise<PairDeviceResult>;

/**
 * El móvil canjea un código por el token de su dispositivo. En UNA transacción: canjea el código (solo si sigue vigente), bloquea el
 * vehículo, revoca el dispositivo activo (un solo activo por vehículo, migración 004) y crea el nuevo. Si algo falla, nada queda a
 * medias: el código sigue valiendo. Un código inexistente, usado o vencido es el MISMO `InvalidPairingCodeError`.
 *
 * El token en claro se devuelve UNA vez; se guarda solo su sha256. Ni el código ni el token se registran en logs.
 */
export function createPairDevice(deps: PairDeviceDependencies): PairDevice {
  return async ({ code }) => {
    const codeHash = deps.hash(code);
    const deviceId = deps.credentials.newDeviceId();
    const deviceToken = deps.credentials.newDeviceToken();

    const paired = await deps.unitOfWork.run(async (transaction) => {
      const consumed = await transaction.consumeCode(codeHash);
      if (consumed === null) return null;
      const vehicle = await transaction.lockVehicle(consumed.tenantId, consumed.vehicleId);
      // La clave foránea compuesta del código garantiza el vehículo: si falta, es una invariante rota, no un código inválido.
      if (vehicle === null) throw new PairingInconsistencyError("El vehículo de un código vigente no existe.");
      await transaction.revokeActiveDevices(consumed.tenantId, consumed.vehicleId);
      const { createdAt } = await transaction.insertDevice({
        deviceId,
        tenantId: consumed.tenantId,
        vehicleId: consumed.vehicleId,
        tokenHash: deps.hash(deviceToken),
      });
      return { tenantId: consumed.tenantId, vehicleId: consumed.vehicleId, plate: vehicle.plate, pairedAt: createdAt };
    });

    if (paired === null) throw new InvalidPairingCodeError();
    return {
      response: { deviceToken, vehicleId: paired.vehicleId, plate: paired.plate, pairedAt: paired.pairedAt.toISOString() },
      tenantId: paired.tenantId,
      deviceId,
    };
  };
}
