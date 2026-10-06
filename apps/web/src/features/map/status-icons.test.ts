import { describe, expect, it } from "vitest";
import { mapMarker, vehicleStatusColors, VEHICLE_STATUSES } from "../../design/tokens";
import { iconNameOf, rasterizeIcon, SHAPE_BY_STATUS, statusIcons } from "./status-icons";

const pixel = (icon: ReturnType<typeof rasterizeIcon>, x: number, y: number) => {
  const offset = (y * icon.width + x) * 4;
  return [...icon.data.slice(offset, offset + 4)];
};
const rgb = (hex: string) => {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
};

describe("íconos de estado", () => {
  it("cada estado tiene una forma distinta (no solo color)", () => {
    expect(new Set(VEHICLE_STATUSES.map((status) => SHAPE_BY_STATUS[status])).size).toBe(VEHICLE_STATUSES.length);
  });

  it("el círculo tiene el color del token en el centro, halo en el borde y esquinas transparentes", () => {
    const icon = rasterizeIcon("circle", vehicleStatusColors.moving, 36, 4);
    expect(pixel(icon, 18, 18)).toEqual([...rgb(vehicleStatusColors.moving), 255]);
    expect(pixel(icon, 18, 1)).toEqual([...rgb(mapMarker.halo), 255]);
    expect(pixel(icon, 0, 0)[3]).toBe(0);
  });

  it("el anillo de 'sin señal' es hueco", () => {
    const icon = rasterizeIcon("ring", vehicleStatusColors.no_signal, 36, 4);
    expect(pixel(icon, 18, 18)[3]).toBe(0);
    expect(pixel(icon, 18, 6)).toEqual([...rgb(vehicleStatusColors.no_signal), 255]);
  });

  it("el triángulo apunta hacia arriba: base ancha abajo, punta angosta arriba", () => {
    const icon = rasterizeIcon("triangle", vehicleStatusColors.stopped_critical, 36, 4);
    expect(pixel(icon, 8, 28)[3]).toBe(255);
    expect(pixel(icon, 8, 8)[3]).toBe(0);
  });

  it("genera un ícono por estado con el nombre que usa la capa", () => {
    const icons = statusIcons(2);
    expect(icons.map((icon) => icon.name)).toEqual(VEHICLE_STATUSES.map(iconNameOf));
    expect(icons[0]?.icon.width).toBe(mapMarker.iconSize * 2);
  });
});
