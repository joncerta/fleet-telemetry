import { describe, expect, it } from "vitest";
import { NOW_ISO, VEHICLE_A, VEHICLE_B, vehicleState, ZONE_CRITICAL } from "../../test-support/fixtures";
import { toVehicleFeatures } from "./vehicle-features";

describe("toVehicleFeatures", () => {
  it("una feature por vehículo, en orden [lng, lat], con id y estado y SIN la placa", () => {
    const collection = toVehicleFeatures(
      {
        [VEHICLE_A]: vehicleState({ vehicleId: VEHICLE_A, lon: -74.08, lat: 4.62 }),
        [VEHICLE_B]: vehicleState({ vehicleId: VEHICLE_B, movement: "stopped", stoppedSince: NOW_ISO, zoneIds: [ZONE_CRITICAL] }),
      },
      NOW_ISO,
      new Set([ZONE_CRITICAL]),
    );

    expect(collection.type).toBe("FeatureCollection");
    expect(collection.features).toHaveLength(2);
    const [first, second] = collection.features;
    expect(first?.geometry).toEqual({ type: "Point", coordinates: [-74.08, 4.62] });
    expect(first?.properties).toEqual({ vehicleId: VEHICLE_A, status: "moving", rank: 2 });
    expect(second?.properties.status).toBe("stopped_critical");
    expect(JSON.stringify(collection)).not.toContain("NRT101");
  });
});
