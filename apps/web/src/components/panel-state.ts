/**
 * Estado abierto/cerrado de los paneles desplegables, recordado por usuario en `localStorage`. Funciones puras (el almacenamiento se
 * inyecta): `localStorage` puede no existir (SSR), estar bloqueado (modo privado, política del navegador), llenarse o traer basura.
 * Nada de esto puede romper el dashboard: ante cualquier fallo se usan los valores por defecto.
 */
export type PanelPreferences = Readonly<Record<string, boolean>>;

/** Lo mínimo que se usa de `Storage`, para poder probarlo con un falso. */
export type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

const KEY_PREFIX = "fleet.panels.v1:";

export const panelStorageKey = (userId: string): string => `${KEY_PREFIX}${userId}`;

/** Lo que se usa de `Storage` para borrar las preferencias. */
export type ClearableStorage = Pick<Storage, "length" | "key" | "removeItem">;

/** Borra las preferencias de todos los usuarios de este navegador (al cerrar sesión, para equipos compartidos). Nunca lanza. */
export function clearPanelPreferences(storage: ClearableStorage | null): void {
  if (storage === null) return;
  try {
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(KEY_PREFIX)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    // Sin acceso al almacenamiento: no hay nada que borrar.
  }
}

/** Solo conserva entradas `string -> boolean`; cualquier otra forma (JSON roto, arreglo, valores raros) se descarta. */
export function parsePanelPreferences(raw: string | null): PanelPreferences {
  if (raw === null) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"));
  } catch {
    return {};
  }
}

export function readPanelPreferences(storage: PreferenceStorage | null, key: string): PanelPreferences {
  if (storage === null) return {};
  try {
    return parsePanelPreferences(storage.getItem(key));
  } catch {
    return {};
  }
}

/** Guarda la preferencia de un panel sin perder las de los demás. Devuelve `false` si no se pudo persistir (solo vale para esta sesión). */
export function writePanelPreference(storage: PreferenceStorage | null, key: string, panelId: string, open: boolean): boolean {
  if (storage === null) return false;
  try {
    const next = { ...readPanelPreferences(storage, key), [panelId]: open };
    storage.setItem(key, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}

/** `localStorage` del navegador, o `null` si no existe o el acceso lanza (algunos navegadores lanzan al solo leer la propiedad). */
export function browserStorage(): (PreferenceStorage & ClearableStorage) | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export const resolveOpen = (preferences: PanelPreferences, panelId: string, defaultOpen: boolean): boolean => preferences[panelId] ?? defaultOpen;
