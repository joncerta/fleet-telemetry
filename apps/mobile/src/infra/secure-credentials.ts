import * as SecureStore from "expo-secure-store";
import type { TokenVault } from "../core/credentials";

const KEY = "fleet.device.token";

/** Token en `expo-secure-store` (Keystore de Android). */
export const secureTokenVault: TokenVault = {
  get: () => SecureStore.getItemAsync(KEY),
  // Sin AFTER_FIRST_UNLOCK la tarea en segundo plano no podría leer el token con el teléfono bloqueado.
  set: (token) => SecureStore.setItemAsync(KEY, token, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK }),
  delete: () => SecureStore.deleteItemAsync(KEY),
};
