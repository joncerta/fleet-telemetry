/**
 * Tokens del diseño: ÚNICA fuente de colores, tipografía y radios. Alimentan el tema de Tailwind (`tailwind.config.ts`) y las capas
 * de MapLibre (que no entienden clases de Tailwind). Nunca se hardcodea un color fuera de este módulo.
 *
 * Origen (apps/web/design, sin desempaquetar el bundle: el pixel perfect está fuera de alcance):
 * - Del diseño, legibles a simple vista: fondo `#f5f4ef`, superficie `#faf9f5`, tinta `#1f1e1d`, tinta secundaria `#6b6a68` y la pila de
 *   fuentes del sistema a 14px/1.4.
 * - PROPUESTOS aquí, no verificados contra el diseño: línea, acento, foco y los colores semánticos de estado y de zona (la semántica la
 *   fija apps/web/CLAUDE.md: verde en movimiento, ámbar detenido, rojo zona crítica, gris sin señal, azul depósito). Todos cumplen
 *   contraste AA (>= 4.5:1) sobre `surface` para texto.
 */

export const palette = {
  canvas: "#f5f4ef",
  surface: "#faf9f5",
  raised: "#ffffff",
  ink: "#1f1e1d",
  inkMuted: "#6b6a68",
  line: "#d9d6cc",
  focus: "#1d4ed8",
  danger: "#b42318",
  dangerSoft: "#fdecea",
  success: "#1e7a3c",
  successSoft: "#e8f4ec",
  warning: "#a15c07",
  warningSoft: "#fdf3e1",
} as const;

/** Estado visual de un vehículo. `stopped_critical`: detenido dentro de una zona crítica. `unknown`: un `movement` que esta versión no conoce. */
export const VEHICLE_STATUSES = ["moving", "stopped", "stopped_critical", "no_signal", "unknown"] as const;
export type VehicleStatus = (typeof VEHICLE_STATUSES)[number];

export const vehicleStatusColors: Record<VehicleStatus, string> = {
  moving: "#1e7a3c",
  stopped: "#a15c07",
  stopped_critical: "#b42318",
  no_signal: "#6b6a68",
  unknown: "#4b4a48",
};

/** Zonas por `kind` (incluye `unknown`, la lectura tolerante de un tipo nuevo). Relleno translúcido y borde sólido. */
export const zoneKindStyles = {
  critical: { fill: "#b42318", fillOpacity: 0.18, line: "#b42318" },
  depot: { fill: "#1d4ed8", fillOpacity: 0.14, line: "#1d4ed8" },
  customer: { fill: "#6b6a68", fillOpacity: 0.12, line: "#6b6a68" },
  unknown: { fill: "#4b4a48", fillOpacity: 0.08, line: "#4b4a48" },
} as const;

/** Halo que separa los íconos del mapa del fondo y anillo del vehículo seleccionado. */
export const mapMarker = {
  halo: "#ffffff",
  selectedRing: "#1d4ed8",
  /** Lado del ícono en píxeles CSS (se rasteriza al doble para pantallas densas). */
  iconSize: 18,
} as const;

export const typography = {
  /** Pila del sistema del diseño (`system-ui, -apple-system, "Segoe UI", sans-serif`). */
  sans: ["system-ui", "-apple-system", '"Segoe UI"', "sans-serif"],
  mono: ["ui-monospace", "SFMono-Regular", "Consolas", "monospace"],
} as const;

/** Tema de Tailwind (se monta en `theme.extend`). Los nombres son los que usan las clases: `bg-canvas`, `text-ink-muted`, `bg-status-moving`… */
export const tailwindTheme = {
  colors: {
    canvas: palette.canvas,
    surface: palette.surface,
    raised: palette.raised,
    ink: { DEFAULT: palette.ink, muted: palette.inkMuted },
    line: palette.line,
    focus: palette.focus,
    danger: { DEFAULT: palette.danger, soft: palette.dangerSoft },
    success: { DEFAULT: palette.success, soft: palette.successSoft },
    warning: { DEFAULT: palette.warning, soft: palette.warningSoft },
    status: {
      moving: vehicleStatusColors.moving,
      stopped: vehicleStatusColors.stopped,
      critical: vehicleStatusColors.stopped_critical,
      "no-signal": vehicleStatusColors.no_signal,
      unknown: vehicleStatusColors.unknown,
    },
    zone: {
      critical: zoneKindStyles.critical.line,
      depot: zoneKindStyles.depot.line,
      customer: zoneKindStyles.customer.line,
    },
  },
  fontFamily: { sans: [...typography.sans], mono: [...typography.mono] },
};
