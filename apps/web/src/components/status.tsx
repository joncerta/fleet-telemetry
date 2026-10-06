import type { VehicleStatus } from "../design/tokens";

export const STATUS_LABELS: Record<VehicleStatus, string> = {
  moving: "En movimiento",
  stopped: "Detenido",
  stopped_critical: "Detenido en zona crítica",
  no_signal: "Sin señal",
  unknown: "Estado desconocido",
};

// Mapas completos de clases (nunca construidas con template strings: Tailwind no las generaría).
const FILL_CLASS: Record<VehicleStatus, string> = {
  moving: "fill-status-moving",
  stopped: "fill-status-stopped",
  stopped_critical: "fill-status-critical",
  no_signal: "fill-status-no-signal",
  unknown: "fill-status-unknown",
};
const STROKE_CLASS: Record<VehicleStatus, string> = {
  moving: "stroke-status-moving",
  stopped: "stroke-status-stopped",
  stopped_critical: "stroke-status-critical",
  no_signal: "stroke-status-no-signal",
  unknown: "stroke-status-unknown",
};

/**
 * Forma del estado, la misma que en el mapa (círculo, cuadrado, triángulo, anillo, rombo): el estado se distingue por forma además de
 * color. Decorativa (`aria-hidden`): el texto del estado siempre la acompaña.
 */
export function StatusGlyph({ status, className = "size-3.5" }: { status: VehicleStatus; className?: string }) {
  const fill = FILL_CLASS[status];
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" className={className}>
      {status === "moving" && <circle cx="8" cy="8" r="6.5" className={fill} />}
      {status === "stopped" && <rect x="2" y="2" width="12" height="12" className={fill} />}
      {status === "stopped_critical" && <polygon points="8,1.5 15,14.5 1,14.5" className={fill} />}
      {status === "no_signal" && <circle cx="8" cy="8" r="5.5" fill="none" strokeWidth="2.5" className={STROKE_CLASS[status]} />}
      {status === "unknown" && <polygon points="8,1 15,8 8,15 1,8" className={fill} />}
    </svg>
  );
}

export function StatusLabel({ status }: { status: VehicleStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <StatusGlyph status={status} />
      <span>{STATUS_LABELS[status]}</span>
    </span>
  );
}
