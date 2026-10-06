import * as SecureStore from "expo-secure-store";
import { deviceCredentialsSchema, type CredentialsStore, type DeviceCredentials } from "../core/credentials";

const KEY = "fleet.device.credentials";

/** Credenciales en `expo-secure-store` (Keystore de Android): nunca en SQLite, AsyncStorage ni variables públicas. */
export const secureCredentials: CredentialsStore = {
  async get(): Promise<DeviceCredentials | null> {
    const raw = await SecureStore.getItemAsync(KEY);
    if (raw === null) return null;
    try {
      const parsed = deviceCredentialsSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  },
  async getToken(): Promise<string | null> {
    return (await this.get())?.token ?? null;
  },
  async save(credentials: DeviceCredentials): Promise<void> {
    // Sin AFTER_FIRST_UNLOCK la tarea en segundo plano no podría leer el token con el teléfono bloqueado.
    await SecureStore.setItemAsync(KEY, JSON.stringify(credentials), {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
    });
  },
  async clear(): Promise<void> {
    await SecureStore.deleteItemAsync(KEY);
  },
};
