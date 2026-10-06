import type { AlertTolerant, FleetSummary, SseSnapshotTolerant, StoppedVehiclesResponseTolerant, VehicleStateTolerant } from "@fleet/contracts";

/** Datos de prueba INVENTADOS (placas y coordenadas de demo en Bogotá), válidos contra los esquemas de `@fleet/contracts`. */
export const VEHICLE_A = "f1ee7000-0000-4000-9000-000000001001";
export const VEHICLE_B = "f1ee7000-0000-4000-9000-000000001002";
export const VEHICLE_C = "f1ee7000-0000-4000-9000-000000001003";
export const ZONE_CRITICAL = "f1ee7000-0000-4000-a000-000000000001";
export const ZONE_DEPOT = "f1ee7000-0000-4000-a000-000000000003";

export const NOW_ISO = "2026-10-06T15:00:00.000Z";
export const NOW_MS = Date.parse(NOW_ISO);

export function vehicleState(overrides: Partial<VehicleStateTolerant> = {}): VehicleStateTolerant {
  return {
    vehicleId: VEHICLE_A,
    plate: "NRT101",
    lon: -74.1,
    lat: 4.65,
    recordedAt: NOW_ISO,
    receivedAt: NOW_ISO,
    speedMps: 10,
    headingDeg: 90,
    movement: "moving",
    stoppedSince: null,
    zoneIds: [],
    mocked: false,
    lowAccuracy: false,
    seq: "10",
    ...overrides,
  };
}

let alertCounter = 0;
export function alert(overrides: Partial<AlertTolerant> = {}): AlertTolerant {
  alertCounter += 1;
  return {
    alertId: `5d3c9a1e-0000-4000-8000-${String(alertCounter).padStart(12, "0")}`,
    vehicleId: VEHICLE_A,
    plate: "NRT101",
    type: "critical_zone_stop",
    zoneId: ZONE_CRITICAL,
    zoneName: "Zona crítica Norte",
    startedAt: NOW_ISO,
    raisedAt: NOW_ISO,
    resolvedAt: null,
    seq: "20",
    ...overrides,
  };
}

export function snapshot(overrides: Partial<SseSnapshotTolerant> = {}): SseSnapshotTolerant {
  return { serverTime: NOW_ISO, cursor: "100", vehicles: [], alerts: [], ...overrides };
}

export function summary(overrides: Partial<FleetSummary> = {}): FleetSummary {
  return { serverTime: NOW_ISO, vehicles: { total: 15, moving: 10, stopped: 3, noSignal: 2 }, activeAlerts: 1, ...overrides };
}

export function stoppedResponse(items: StoppedVehiclesResponseTolerant["items"] = []): StoppedVehiclesResponseTolerant {
  return { serverTime: NOW_ISO, items };
}
