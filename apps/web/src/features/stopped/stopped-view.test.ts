import { describe, expect, it } from "vitest";
import { NOW_MS, VEHICLE_A, VEHICLE_B, VEHICLE_C, vehicleState, ZONE_CRITICAL } from "../../test-support/fixtures";
import { stoppedRows, type StoppedItem } from "./stopped-view";

const item = (vehicleId: string, stoppedSince: string): StoppedItem => ({
  vehicleId,
  plate: "NRT101",
  stoppedSince,
  stoppedMinutes: 25,
  lon: -74.1,
  lat: 4.65,
  zone: { zoneId: ZONE_CRITICAL, name: "Zona crítica Norte", kind: "critical" },
});

describe("stoppedRows", () => {
  it("calcula los minutos con la hora del servidor y ordena de más a menos minutos", () => {
    const rows = stoppedRows([item(VEHICLE_A, "2026-10-06T14:35:00.000Z"), item(VEHICLE_B, "2026-10-06T14:10:00.000Z")], {}, NOW_MS, 20);
    expect(rows.map((row) => [row.item.vehicleId, row.minutes])).toEqual([
      [VEHICLE_B, 50],
      [VEHICLE_A, 25],
    ]);
  });

  it("quita la fila si el estado en vivo dice que el vehículo ya se mueve o empezó otra detención", () => {
    const since = "2026-10-06T14:35:00.000Z";
    const rows = stoppedRows(
      [item(VEHICLE_A, since), item(VEHICLE_B, since), item(VEHICLE_C, since)],
      {
        [VEHICLE_A]: vehicleState({ vehicleId: VEHICLE_A, movement: "moving", stoppedSince: null }),
        [VEHICLE_B]: vehicleState({ vehicleId: VEHICLE_B, movement: "stopped", stoppedSince: "2026-10-06T14:58:00.000Z" }),
        [VEHICLE_C]: vehicleState({ vehicleId: VEHICLE_C, movement: "stopped", stoppedSince: "2026-10-06T09:35:00.000-05:00" }),
      },
      NOW_MS,
      20,
    );
    // C es la misma detención (mismo instante con otro offset).
    expect(rows.map((row) => row.item.vehicleId)).toEqual([VEHICLE_C]);
  });

  it("nunca muestra menos minutos que el mínimo de la consulta por un desfase de segundos", () => {
    const rows = stoppedRows([item(VEHICLE_A, "2026-10-06T14:40:30.000Z")], {}, NOW_MS, 20);
    expect(rows[0]?.minutes).toBe(20);
  });
});
