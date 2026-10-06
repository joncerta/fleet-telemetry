import { hasNoSignal, NO_SIGNAL_THRESHOLD_MS } from "@fleet/contracts";
import { describe, expect, it } from "vitest";
import { noSignalCutoff, pickDisplayZone, stoppedMinutes, stoppedSinceCutoff, type ZoneRef } from "./fleet-status.js";

const SERVER_TIME = new Date("2026-10-06T12:00:00.000Z");

describe("noSignalCutoff", () => {
  it("es la hora del servidor menos el umbral del contrato", () => {
    expect(noSignalCutoff(SERVER_TIME).getTime()).toBe(SERVER_TIME.getTime() - NO_SIGNAL_THRESHOLD_MS);
  });

  it("coincide con hasNoSignal en el borde: un receivedAt anterior al corte está sin señal y uno igual o posterior, no", () => {
    const cutoff = noSignalCutoff(SERVER_TIME).getTime();

    for (const [receivedAtMs, expected] of [
      [cutoff - 1, true],
      [cutoff, false],
      [cutoff + 1, false],
    ] as const) {
      const receivedAt = new Date(receivedAtMs);
      expect(receivedAt < noSignalCutoff(SERVER_TIME)).toBe(expected);
      expect(hasNoSignal(receivedAt.toISOString(), SERVER_TIME.toISOString())).toBe(expected);
    }
  });
});

describe("stoppedMinutes", () => {
  it("son los minutos ENTEROS (se trunca, no se redondea)", () => {
    expect(stoppedMinutes(new Date("2026-10-06T11:40:00.000Z"), SERVER_TIME)).toBe(20);
    expect(stoppedMinutes(new Date("2026-10-06T11:40:00.001Z"), SERVER_TIME)).toBe(19);
    expect(stoppedMinutes(new Date("2026-10-06T11:39:01.000Z"), SERVER_TIME)).toBe(20);
  });

  it("nunca es negativo, aunque stoppedSince esté en el futuro por desfase de relojes", () => {
    expect(stoppedMinutes(new Date("2026-10-06T12:05:00.000Z"), SERVER_TIME)).toBe(0);
  });
});

describe("stoppedSinceCutoff", () => {
  it("equivale a stoppedMinutes >= minMinutes", () => {
    const cutoff = stoppedSinceCutoff(SERVER_TIME, 20);

    for (const offsetMs of [-1, 0, 1]) {
      const stoppedSince = new Date(cutoff.getTime() + offsetMs);
      expect(stoppedSince <= cutoff).toBe(stoppedMinutes(stoppedSince, SERVER_TIME) >= 20);
    }
  });
});

describe("pickDisplayZone", () => {
  const critical: ZoneRef = { zoneId: "00000000-0000-4000-8000-000000000002", name: "Crítica", kind: "critical" };
  const customer: ZoneRef = { zoneId: "00000000-0000-4000-8000-000000000001", name: "Cliente", kind: "customer" };
  const depot: ZoneRef = { zoneId: "00000000-0000-4000-8000-000000000003", name: "Depósito", kind: "depot" };

  it("sin zonas no hay zona", () => {
    expect(pickDisplayZone([])).toBeNull();
  });

  it("con varias zonas muestra la crítica primero, luego cliente y depósito, sin importar el orden de entrada", () => {
    expect(pickDisplayZone([depot, customer, critical])).toEqual(critical);
    expect(pickDisplayZone([depot, customer])).toEqual(customer);
    expect(pickDisplayZone([depot])).toEqual(depot);
  });

  it("entre zonas del mismo tipo elige la de menor zoneId (determinista)", () => {
    const other: ZoneRef = { ...critical, zoneId: "00000000-0000-4000-8000-000000000000", name: "Otra crítica" };

    expect(pickDisplayZone([critical, other])).toEqual(other);
    expect(pickDisplayZone([other, critical])).toEqual(other);
  });

  it("con un filtro de tipo solo cuentan las zonas de ese tipo, aunque haya una crítica", () => {
    expect(pickDisplayZone([critical, customer, depot], "customer")).toEqual(customer);
    expect(pickDisplayZone([critical, depot], "customer")).toBeNull();
  });

  it("no modifica el arreglo que recibe", () => {
    const zones = [depot, critical];

    pickDisplayZone(zones);

    expect(zones).toEqual([depot, critical]);
  });
});
