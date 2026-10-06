import type { Outbox } from "./outbox";
import { buildPoint, type RawFix } from "./point";

export interface CaptureResult {
  readonly enqueued: number;
  /** No se encolaron: no pasaron `telemetryPointSchema` o el dispositivo no está vinculado. Se cuentan, no se pierden en silencio. */
  readonly invalid: number;
  /** `timestamp` más reciente de los fixes encolados, para el diagnóstico. */
  readonly lastFixAt: number | null;
}

/**
 * Convierte los fixes que entregó el sistema en puntos validados y los ESCRIBE en la cola. No envía nada: el sync es de
 * otro módulo. Lo llama la tarea en segundo plano (sin React ni store de la app).
 */
export async function captureFixes(
  fixes: readonly RawFix[],
  deps: { outbox: Outbox; vehicleId: string | null; newEventId: () => string; minAccuracyM?: number },
): Promise<CaptureResult> {
  let enqueued = 0;
  let invalid = 0;
  let lastFixAt: number | null = null;
  for (const fix of fixes) {
    const built =
      deps.vehicleId === null
        ? ({ ok: false } as const)
        : buildPoint(fix, {
            vehicleId: deps.vehicleId,
            newEventId: deps.newEventId,
            ...(deps.minAccuracyM !== undefined && { minAccuracyM: deps.minAccuracyM }),
          });
    if (!built.ok) {
      invalid++;
      await deps.outbox.countInvalid();
      continue;
    }
    await deps.outbox.enqueue(built.point);
    enqueued++;
    lastFixAt = Math.max(lastFixAt ?? 0, fix.timestamp);
  }
  return { enqueued, invalid, lastFixAt };
}
