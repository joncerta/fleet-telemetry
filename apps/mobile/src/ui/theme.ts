/**
 * Tokens de estilo. Neutros cálidos tomados del diseño de la web (`apps/web/design/`): fondo #faf9f5, superficie #f5f4ef,
 * texto #1f1e1d y texto secundario #6b6a68. Los colores de estado (ok/aviso/error) son los de la web para alertas.
 */
export const colors = {
  background: "#faf9f5",
  surface: "#f5f4ef",
  surfaceStrong: "#ffffff",
  text: "#1f1e1d",
  textMuted: "#6b6a68",
  border: "#dcdad2",
  primary: "#1f1e1d",
  onPrimary: "#faf9f5",
  ok: "#1b7f4b",
  warn: "#a15c00",
  danger: "#b3261e",
  dangerSurface: "#2a1215",
  onDanger: "#ff8a80",
} as const;

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;
export const radius = { md: 12, lg: 16 } as const;
/** Área táctil mínima (Material: 48 dp). Los botones principales son más grandes. */
export const touch = { min: 48, primary: 64 } as const;
export const font = { body: 16, small: 14, title: 22, big: 34 } as const;
