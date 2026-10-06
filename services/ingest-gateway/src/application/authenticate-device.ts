import { deviceTokenSchema } from "@fleet/contracts";
import type { DeviceContext } from "../domain/device.js";
import { DeviceDirectoryUnavailableError } from "./errors.js";
import type { DeviceRepository } from "./ports.js";

export interface AuthenticateDeviceDependencies {
  readonly devices: DeviceRepository;
  /** `sha256Hex` de la plataforma, la misma función con que `pnpm device:token` guarda `devices.token_hash`. */
  readonly hashToken: (token: string) => string;
}

/**
 * Autentica al dispositivo a partir del token del header `Authorization: Bearer`.
 *
 * Devuelve su identidad o `null` por CUALQUIER motivo: token ausente, con formato inválido (`deviceTokenSchema`),
 * desconocido o revocado. No distingue entre ellos a propósito, para no revelar si un token existe. Un token mal
 * formado ni siquiera llega a la base. Un fallo de la base NO es un "no autenticado": lanza `DeviceDirectoryUnavailableError`
 * (la entrada responde 503 con `Retry-After`).
 *
 * 403 no aplica en el modelo actual: el token da una sola identidad (tenant, dispositivo, vehículo) y no hay roles ni
 * permisos que un dispositivo autenticado pueda no tener. Un vehículo ajeno en un punto es un rechazo por punto.
 */
export function createAuthenticateDevice(deps: AuthenticateDeviceDependencies): (token: string | undefined) => Promise<DeviceContext | null> {
  return async (token) => {
    const parsed = deviceTokenSchema.safeParse(token);
    if (!parsed.success) return null;
    try {
      return await deps.devices.findActiveByTokenHash(deps.hashToken(parsed.data));
    } catch (error) {
      throw new DeviceDirectoryUnavailableError(error);
    }
  };
}
