import { formatTime } from "../lib/format";
import type { Loadable } from "../lib/loadable";

/** Fallo de un panel: `summary` para el encabezado (visible cerrado) y `message` para el aviso completo. */
export interface PanelError {
  readonly summary: string;
  readonly message: string;
}

/**
 * Aviso de un recurso que falló. Sale de `error` (que `loading()` conserva entre recargas) y no del estado: con la API caída, cada recarga
 * no cambia el aviso, así que no se desmonta y vuelve a montar (el lector de pantalla no lo repetiría). Con datos viejos, dice de cuándo son.
 */
export function panelError(resource: Pick<Loadable<unknown>, "error" | "updatedAt">, staleLabel: string): PanelError | null {
  if (resource.error === null) return null;
  const since = resource.updatedAt === null ? null : formatTime(resource.updatedAt);
  return {
    summary: since === null ? "Error" : `Error · datos de las ${since}`,
    message: since === null ? resource.error : `${resource.error} ${staleLabel} de las ${since}.`,
  };
}
