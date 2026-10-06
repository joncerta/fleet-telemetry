import { telemetryPointSchema, type TelemetryPoint } from "@fleet/contracts";
import { PARAMS } from "./params";

/** Lo que el sistema operativo entrega de un fix, ya sin tipos de expo-location (el núcleo no los importa). */
export interface RawFix {
  /** `location.timestamp`: milisegundos de época del fix GPS. NO `Date.now()`. */
  readonly timestamp: number;
  readonly latitude: number;
  readonly longitude: number;
  readonly altitude: number | null;
  readonly accuracy: number | null;
  readonly speed: number | null;
  readonly heading: number | null;
  /** `location.mocked` (solo Android). */
  readonly mocked: boolean | undefined;
}

export type BuildPointResult =
  | { readonly ok: true; readonly point: TelemetryPoint }
  /** `reason` nunca lleva coordenadas: se puede loguear. */
  | { readonly ok: false; readonly reason: "invalid_point" };

/** Android entrega -1 (o negativos) cuando no tiene el dato. */
function nonNegativeOrNull(value: number | null, max: number): number | null {
  if (value === null || !Number.isFinite(value) || value < 0 || value > max) return null;
  return value;
}

/**
 * Convierte un fix en un punto del contrato.
 *
 * - `recordedAt` sale de la hora del fix (`fix.timestamp`), nunca del reloj del teléfono al procesarlo.
 * - Precisión peor que `PARAMS.minAccuracyM` (o desconocida): el punto se guarda marcado `lowAccuracy`, no se descarta.
 * - `mocked` se propaga tal cual: es una señal de fraude que el back debe ver; nunca se descarta en silencio.
 * - Se valida contra `telemetryPointSchema` antes de encolar; si no pasa, `ok: false` (el llamador lo cuenta).
 */
export function buildPoint(
  fix: RawFix,
  ctx: { vehicleId: string; newEventId: () => string; minAccuracyM?: number },
): BuildPointResult {
  const minAccuracy = ctx.minAccuracyM ?? PARAMS.minAccuracyM;
  const accuracy = fix.accuracy !== null && Number.isFinite(fix.accuracy) && fix.accuracy > 0 ? fix.accuracy : null;
  const heading = nonNegativeOrNull(fix.heading, 360);
  const candidate = {
    eventId: ctx.newEventId(),
    vehicleId: ctx.vehicleId,
    recordedAt: Number.isFinite(fix.timestamp) ? new Date(fix.timestamp).toISOString() : "",
    lon: fix.longitude,
    lat: fix.latitude,
    speedMps: nonNegativeOrNull(fix.speed, 150),
    headingDeg: heading === null ? null : heading % 360,
    accuracyM: accuracy,
    altitudeM: fix.altitude !== null && Number.isFinite(fix.altitude) ? fix.altitude : null,
    mocked: fix.mocked === true,
    lowAccuracy: accuracy === null || accuracy > minAccuracy,
  };
  const parsed = telemetryPointSchema.safeParse(candidate);
  return parsed.success ? { ok: true, point: parsed.data } : { ok: false, reason: "invalid_point" };
}
