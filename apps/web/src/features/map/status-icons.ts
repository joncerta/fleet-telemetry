import { mapMarker, vehicleStatusColors, VEHICLE_STATUSES, type VehicleStatus } from "../../design/tokens";

/**
 * Íconos de estado del mapa, rasterizados en código (sin imágenes externas ni glifos de la fuente del estilo). Cada estado se distingue
 * por FORMA además de color (accesibilidad): círculo = en movimiento, cuadrado = detenido, triángulo = detenido en zona crítica,
 * anillo hueco = sin señal, rombo = desconocido.
 */
export type IconShape = "circle" | "square" | "triangle" | "ring" | "diamond";

export const SHAPE_BY_STATUS: Record<VehicleStatus, IconShape> = {
  moving: "circle",
  stopped: "square",
  stopped_critical: "triangle",
  no_signal: "ring",
  unknown: "diamond",
};

/** Prefijo de los nombres de imagen: la capa arma `vehicle-<estado>` con una expresión `concat`. */
export const ICON_PREFIX = "vehicle-";
export const iconNameOf = (status: VehicleStatus): string => `${ICON_PREFIX}${status}`;

export interface RasterIcon {
  width: number;
  height: number;
  /** RGBA, fila por fila. */
  data: Uint8Array;
}

function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** ¿El punto (x, y), con origen en el centro y radio 1, está dentro de la forma? `inset` encoge la forma (para el halo). */
function inside(shape: IconShape, x: number, y: number, inset: number): boolean {
  const r = 1 - inset;
  switch (shape) {
    case "circle":
      return x * x + y * y <= r * r;
    case "ring": {
      const d = x * x + y * y;
      const hole = Math.max(0, r - 0.38);
      return d <= r * r && d >= hole * hole;
    }
    case "square":
      return Math.abs(x) <= r * 0.8 && Math.abs(y) <= r * 0.8;
    case "diamond":
      return Math.abs(x) + Math.abs(y) <= r;
    case "triangle": {
      // Triángulo con la punta arriba (y negativo es arriba en la imagen).
      const top = -r;
      const bottom = r * 0.75;
      if (y < top || y > bottom) return false;
      const halfWidth = ((y - top) / (bottom - top)) * r;
      return Math.abs(x) <= halfWidth;
    }
  }
}

/** Rasteriza `shape` con relleno `color` y un halo `mapMarker.halo` de `haloPx` píxeles. */
export function rasterizeIcon(shape: IconShape, color: string, sizePx: number, haloPx = 2): RasterIcon {
  const data = new Uint8Array(sizePx * sizePx * 4);
  const [r, g, b] = hexToRgb(color);
  const [hr, hg, hb] = hexToRgb(mapMarker.halo);
  const halfSize = sizePx / 2;
  const inset = haloPx / halfSize;
  for (let py = 0; py < sizePx; py += 1) {
    for (let px = 0; px < sizePx; px += 1) {
      const x = (px + 0.5 - halfSize) / halfSize;
      const y = (py + 0.5 - halfSize) / halfSize;
      const offset = (py * sizePx + px) * 4;
      // Relleno: la forma encogida. Halo: el borde entre la forma completa y la encogida.
      if (inside(shape, x, y, inset)) data.set([r, g, b, 255], offset);
      else if (inside(shape, x, y, 0)) data.set([hr, hg, hb, 255], offset);
    }
  }
  return { width: sizePx, height: sizePx, data };
}

/** Un ícono por estado, con el color del token. `pixelRatio` 2 para pantallas densas. */
export function statusIcons(pixelRatio = 2): { name: string; icon: RasterIcon; pixelRatio: number }[] {
  const size = mapMarker.iconSize * pixelRatio;
  return VEHICLE_STATUSES.map((status) => ({
    name: iconNameOf(status),
    icon: rasterizeIcon(SHAPE_BY_STATUS[status], vehicleStatusColors[status], size, 2 * pixelRatio),
    pixelRatio,
  }));
}
