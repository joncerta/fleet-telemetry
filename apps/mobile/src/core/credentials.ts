import { deviceTokenSchema } from "@fleet/contracts";
import { z } from "zod";
import type { TokenSource } from "./sync-engine";

export interface DeviceCredentials {
  readonly token: string;
  /** Vehículo ligado al token: el gateway lo compara con el del token y rechaza (`vehicle_mismatch`) lo que no coincide. */
  readonly vehicleId: string;
}

/**
 * Puerto de credenciales del dispositivo. Hoy lo alimenta el pegado manual del token; cuando el backend entregue la
 * vinculación con código de un solo uso (`POST /v1/devices/pair`, fase 1b, todavía sin contrato), solo cambia quién llama
 * a `save` — ni la cola ni el sync se tocan. Implementación real: `infra/secure-credentials.ts` (expo-secure-store).
 */
export interface CredentialsStore extends TokenSource {
  get(): Promise<DeviceCredentials | null>;
  save(credentials: DeviceCredentials): Promise<void>;
  clear(): Promise<void>;
}

export const deviceCredentialsSchema = z.object({
  token: deviceTokenSchema,
  vehicleId: z.uuid(),
});

export type CredentialsInputError = "token_format" | "vehicle_format";

/** Valida lo que el conductor pega. Devuelve credenciales limpias o el campo que está mal (sin eco del valor). */
export function parseCredentialsInput(
  tokenInput: string,
  vehicleInput: string,
): { ok: true; credentials: DeviceCredentials } | { ok: false; error: CredentialsInputError } {
  const token = tokenInput.trim();
  const vehicleId = vehicleInput.trim().toLowerCase();
  if (!deviceTokenSchema.safeParse(token).success) return { ok: false, error: "token_format" };
  if (!z.uuid().safeParse(vehicleId).success) return { ok: false, error: "vehicle_format" };
  return { ok: true, credentials: { token, vehicleId } };
}
