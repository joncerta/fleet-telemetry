import type { PairingCode } from "@fleet/contracts";
import type { AuthIdentity } from "../domain/identity.js";
import { PairingInconsistencyError, VehicleNotFoundError } from "./errors.js";
import type { PairingCodeRepository, PairingCredentials } from "./ports.js";

export interface CreatePairingCodeDependencies {
  codes: PairingCodeRepository;
  credentials: PairingCredentials;
  /** sha256 hexadecimal minúscula (`sha256Hex`): lo único del código que se guarda. */
  hash: (value: string) => string;
  /** Vida del código, en minutos. */
  ttlMinutes: number;
}

export type CreatePairingCode = (input: { identity: AuthIdentity; vehicleId: string }) => Promise<PairingCode>;

/** Intentos ante una colisión del hash. Con 40 bits una colisión es casi imposible; el reintento cubre ese caso sin fallar al operador. */
const MAX_ATTEMPTS = 3;

/**
 * Un operador pide un código para un vehículo de SU tenant. El tenant sale de la sesión: un `vehicleId` de otro tenant es
 * `VehicleNotFoundError` (404), igual que uno inexistente. Solo se guarda el sha256 del código; el código en claro se devuelve UNA vez.
 */
export function createCreatePairingCode(deps: CreatePairingCodeDependencies): CreatePairingCode {
  return async ({ identity, vehicleId }) => {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const code = deps.credentials.newPairingCode();
      const result = await deps.codes.create({
        tenantId: identity.tenantId,
        vehicleId,
        createdBy: identity.userId,
        codeHash: deps.hash(code),
        ttlMinutes: deps.ttlMinutes,
      });
      if (result.status === "vehicle_not_found") throw new VehicleNotFoundError();
      if (result.status === "created") return { code, vehicleId, expiresAt: result.expiresAt.toISOString() };
    }
    throw new PairingInconsistencyError(`No se pudo generar un código único en ${MAX_ATTEMPTS} intentos.`);
  };
}
