import { DEVICE_TOKEN_PREFIX } from "@fleet/contracts";
import { z } from "zod";
import type { OutboxStore } from "./store";
import type { TokenSource } from "./sync-engine";

export interface DeviceCredentials {
  readonly token: string;
  /** Vehículo ligado al token (viene de `POST /v1/devices/pair`). No hay campo editable. */
  readonly vehicleId: string;
}

/** Puerto de credenciales del dispositivo. Implementación: `createCredentialsStore` sobre secure-store y `meta`. */
export interface CredentialsStore extends TokenSource {
  get(): Promise<DeviceCredentials | null>;
  save(credentials: DeviceCredentials): Promise<void>;
  clear(): Promise<void>;
}

/** Bóveda del token (en la app, `expo-secure-store`). El token nunca va a SQLite, AsyncStorage ni variables públicas. */
export interface TokenVault {
  get(): Promise<string | null>;
  set(token: string): Promise<void>;
  delete(): Promise<void>;
}

/** El token es opaco para el móvil: solo se exige el prefijo (como `devicePairResponseTolerantSchema`). */
const tokenShape = z.string().startsWith(DEVICE_TOKEN_PREFIX).min(DEVICE_TOKEN_PREFIX.length + 1);

/**
 * Credenciales = token (en la bóveda segura) + `vehicleId` (en `meta`, no es secreto). Faltando cualquiera de los dos
 * el dispositivo se considera no vinculado.
 */
export function createCredentialsStore(vault: TokenVault, meta: Pick<OutboxStore, "getMeta" | "setMeta">): CredentialsStore {
  const store: CredentialsStore = {
    async get() {
      const [token, vehicleId] = await Promise.all([vault.get(), meta.getMeta("vehicleId")]);
      if (token === null || vehicleId === null) return null;
      if (!tokenShape.safeParse(token).success || !z.uuid().safeParse(vehicleId).success) return null;
      return { token, vehicleId };
    },
    async getToken() {
      return (await store.get())?.token ?? null;
    },
    async save(credentials) {
      await vault.set(credentials.token);
      await meta.setMeta("vehicleId", credentials.vehicleId);
    },
    async clear() {
      await vault.delete();
      await meta.setMeta("vehicleId", null);
    },
  };
  return store;
}
