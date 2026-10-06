export type PermissionStatus = "granted" | "denied" | "undetermined";
/** `blocked`: el sistema ya no vuelve a preguntar; solo se activa desde los ajustes del teléfono. */
export type PermissionStatusDetailed = PermissionStatus | "blocked";

export interface PermissionsSnapshot {
  readonly foreground: PermissionStatusDetailed;
  readonly background: PermissionStatusDetailed;
}

export type TrackingState = "active" | "paused" | "no_permission" | "no_signal";

export interface TrackingInputs {
  readonly shiftActive: boolean;
  readonly permissions: PermissionsSnapshot;
  /**
   * Servicios de ubicación del teléfono encendidos. "Sin señal" se deduce de esto y NO de la antigüedad del último fix:
   * el GPS apagado es la única causa que se puede afirmar sin leer el reloj.
   */
  readonly gpsEnabled: boolean;
}

/**
 * Estado del tracking para el conductor. Sin permiso manda sobre todo (aunque el turno esté marcado como activo, no se
 * está capturando en segundo plano). Con turno activo y el GPS apagado: sin señal.
 */
export function deriveTrackingState(input: TrackingInputs): TrackingState {
  const { foreground, background } = input.permissions;
  if (foreground !== "granted" || background !== "granted") return "no_permission";
  if (!input.shiftActive) return "paused";
  return input.gpsEnabled ? "active" : "no_signal";
}

export type PermissionStep =
  /** Todo concedido. */
  | "done"
  /** Pedir primer plano (sin explicación previa obligatoria más allá de la pantalla de turno). */
  | "request_foreground"
  /** Mostrar la divulgación y luego pedir segundo plano. */
  | "explain_then_request_background"
  /** El sistema no preguntará más: guiar a los ajustes. */
  | "open_settings";

/** Orden obligatorio: primer plano y luego segundo plano. */
export function nextPermissionStep(p: PermissionsSnapshot): PermissionStep {
  if (p.foreground === "blocked" || (p.foreground === "granted" && p.background === "blocked")) return "open_settings";
  if (p.foreground !== "granted") return "request_foreground";
  if (p.background !== "granted") return "explain_then_request_background";
  return "done";
}

/**
 * Desfase estimado del reloj del teléfono respecto al servidor, en ms (positivo: el teléfono va adelantado).
 * Se compensa la mitad del tiempo de ida y vuelta. El contrato v1 no tiene un campo para enviarlo; se muestra en
 * diagnóstico.
 */
export function estimateClockSkewMs(args: { serverTime: string; sentAtMs: number; receivedAtMs: number }): number | null {
  const server = Date.parse(args.serverTime);
  if (Number.isNaN(server)) return null;
  const midpoint = args.sentAtMs + (args.receivedAtMs - args.sentAtMs) / 2;
  return Math.round(midpoint - server);
}
