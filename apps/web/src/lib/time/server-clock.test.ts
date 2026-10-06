import { describe, expect, it } from "vitest";
import { clockOffsetMs, minutesSince, msUntil, serverNowMs } from "./server-clock";

describe("reloj del servidor", () => {
  it("estima el desfase y la hora del servidor desde el reloj local", () => {
    const clientNow = Date.parse("2026-10-06T14:50:00.000Z");
    const offset = clockOffsetMs("2026-10-06T15:00:00.000Z", clientNow);
    expect(offset).toBe(10 * 60_000);
    expect(new Date(serverNowMs(offset ?? 0, clientNow + 30_000)).toISOString()).toBe("2026-10-06T15:00:30.000Z");
  });

  it("devuelve null con una fecha inválida", () => {
    expect(clockOffsetMs("no-es-fecha", 0)).toBeNull();
  });

  it("minutos detenido con desfase de reloj: se cuentan contra la hora del servidor, no la local", () => {
    // Navegador 10 min atrasado. Detenido desde las 14:35 (hora del fix). A las 15:00 del servidor lleva 25 min, no 15.
    const clientNow = Date.parse("2026-10-06T14:50:00.000Z");
    const offset = clockOffsetMs("2026-10-06T15:00:00.000Z", clientNow) ?? 0;
    expect(minutesSince("2026-10-06T14:35:00.000Z", serverNowMs(offset, clientNow))).toBe(25);
    expect(minutesSince("2026-10-06T14:35:00.000Z", clientNow)).toBe(15);
  });

  it("los minutos son enteros hacia abajo y nunca negativos", () => {
    const now = Date.parse("2026-10-06T15:00:00.000Z");
    expect(minutesSince("2026-10-06T14:58:59.000Z", now)).toBe(1);
    expect(minutesSince("2026-10-06T15:03:00.000Z", now)).toBe(0);
    expect(minutesSince("no-es-fecha", now)).toBe(0);
  });

  it("msUntil mide contra la hora del SERVIDOR: con el reloj local adelantado 1 h, un código que vence en 10 min no vence ya", () => {
    const clientNow = Date.parse("2026-10-06T16:00:00.000Z");
    const offset = clockOffsetMs("2026-10-06T15:00:00.000Z", clientNow) ?? 0;
    expect(offset).toBe(-3_600_000);
    // Con el reloj local (sin desfase) ya estaría vencido hace 50 min.
    expect(msUntil("2026-10-06T15:10:00.000Z", clientNow)).toBe(0);
    expect(msUntil("2026-10-06T15:10:00.000Z", serverNowMs(offset, clientNow))).toBe(600_000);
  });

  it("msUntil nunca es negativo ni NaN (un setTimeout negativo avisa en Node)", () => {
    expect(msUntil("2026-10-06T15:00:00.000Z", Date.parse("2026-10-06T15:05:00.000Z"))).toBe(0);
    expect(msUntil("no es una fecha", 1_000)).toBe(0);
  });
});
