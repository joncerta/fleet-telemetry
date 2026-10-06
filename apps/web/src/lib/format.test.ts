import { describe, expect, it } from "vitest";
import { formatAgo, formatDateTime, formatDuration, formatInteger, formatTime } from "./format";

describe("formato es-CO en la zona del usuario", () => {
  const instant = "2026-10-06T20:05:09.000Z";

  it("la misma hora se muestra en la zona del usuario (Bogotá es UTC-5)", () => {
    expect(formatTime(instant, "America/Bogota")).toBe("15:05:09");
    expect(formatTime(instant, "UTC")).toBe("20:05:09");
    expect(formatTime(Date.parse(instant), "America/Bogota")).toBe("15:05:09");
  });

  it("fecha y hora cortas en es-CO", () => {
    expect(formatDateTime(instant, "America/Bogota")).toMatch(/^6\/10\/(20)?26,? 15:05$/);
  });

  it("enteros con separador de miles de es-CO", () => {
    expect(formatInteger(1234567)).toBe("1.234.567");
  });

  it("tiempos relativos y duraciones", () => {
    expect(formatAgo(0)).toBe("hace menos de 1 min");
    expect(formatAgo(12)).toBe("hace 12 min");
    expect(formatAgo(125)).toBe("hace 2 h 5 min");
    expect(formatAgo(120)).toBe("hace 2 h");
    expect(formatDuration(25)).toBe("25 min");
    expect(formatDuration(65)).toBe("1 h 5 min");
  });
});
