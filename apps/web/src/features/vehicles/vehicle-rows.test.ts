import { describe, expect, it } from "vitest";
import { NOW_MS, VEHICLE_A, VEHICLE_B, VEHICLE_C, vehicleState } from "../../test-support/fixtures";
import { vehicleRows } from "./vehicle-rows";

describe("vehicleRows", () => {
  it("ordena por placa con orden natural y calcula estado y minutos contra la hora del servidor", () => {
    const rows = vehicleRows(
      {
        [VEHICLE_A]: vehicleState({ vehicleId: VEHICLE_A, plate: "NRT110" }),
        [VEHICLE_B]: vehicleState({ vehicleId: VEHICLE_B, plate: "NRT102", receivedAt: "2026-10-06T14:48:00.000Z" }),
        [VEHICLE_C]: vehicleState({ vehicleId: VEHICLE_C, plate: "nrt105", movement: "stopped", stoppedSince: "2026-10-06T14:58:00.000Z" }),
      },
      NOW_MS,
      new Set(),
    );
    expect(rows.map((row) => [row.vehicle.plate, row.status, row.minutesSinceData])).toEqual([
      ["NRT102", "no_signal", 12],
      ["nrt105", "stopped", 0],
      ["NRT110", "moving", 0],
    ]);
  });
});
