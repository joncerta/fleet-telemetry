import { PARAMS } from "./params";

/**
 * La tarea en segundo plano recibe un fix cada 5 s: sin límite mandaría un POST por punto. Solo drena si pasaron al menos
 * `intervalMs` (15 s) desde el último drenaje desde segundo plano. Los puntos ya están en SQLite; esto solo decide cuándo
 * enviar. `lastDrainAtMs` vive en `meta` para valer entre procesos. Si el reloj retrocedió, drena (no se queda sin enviar).
 */
export function shouldDrainFromBackground(
  lastDrainAtMs: number | null,
  nowMs: number,
  intervalMs: number = PARAMS.periodicSyncMs,
): boolean {
  if (lastDrainAtMs === null || !Number.isFinite(lastDrainAtMs)) return true;
  if (nowMs < lastDrainAtMs) return true;
  return nowMs - lastDrainAtMs >= intervalMs;
}
