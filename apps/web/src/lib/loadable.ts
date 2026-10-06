/**
 * Un recurso leído de la API. Si una recarga falla, se CONSERVA el dato anterior con su hora (`updatedAt`): la UI lo muestra como viejo
 * ("actualizado a las…") junto al error, nunca como si fuera actual ni lo borra.
 */
export interface Loadable<T> {
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly data: T | null;
  /** Hora local (ms) de la última respuesta válida. */
  readonly updatedAt: number | null;
  readonly error: string | null;
}

export const idle = <T>(): Loadable<T> => ({ status: "idle", data: null, updatedAt: null, error: null });

export const loading = <T>(current: Loadable<T>): Loadable<T> => ({ ...current, status: "loading" });

export const ready = <T>(data: T, nowMs: number): Loadable<T> => ({ status: "ready", data, updatedAt: nowMs, error: null });

export const failed = <T>(current: Loadable<T>, error: string): Loadable<T> => ({ ...current, status: "error", error });
