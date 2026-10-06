import type { Alert, VehicleState } from "@fleet/contracts";
import { describe, expect, it } from "vitest";
import { createSeqTracker, seqOf, snapshotCursor, type FleetStreamEvent } from "./stream-ordering.js";

/** uuid distintos y deterministas: `domain/` no importa `node:crypto`. */
let counter = 0;
const randomUUID = (): string => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;

const state = (vehicleId: string, seq: string): VehicleState => ({
  vehicleId,
  plate: "ABC123",
  lon: -75.5,
  lat: 6.2,
  recordedAt: "2026-10-06T11:59:00.000Z",
  receivedAt: "2026-10-06T11:59:01.000Z",
  speedMps: 0,
  headingDeg: null,
  movement: "moving",
  stoppedSince: null,
  zoneIds: [],
  mocked: false,
  lowAccuracy: false,
  seq,
});

const alert = (alertId: string, seq: string): Alert => ({
  alertId,
  vehicleId: randomUUID(),
  plate: "ABC123",
  type: "critical_zone_stop",
  zoneId: null,
  zoneName: null,
  startedAt: "2026-10-06T11:30:00.000Z",
  raisedAt: "2026-10-06T11:50:00.000Z",
  resolvedAt: null,
  seq,
});

const stateEvent = (vehicleId: string, seq: string): FleetStreamEvent => ({ type: "vehicle.state", state: state(vehicleId, seq) });
const alertEvent = (alertId: string, seq: string): FleetStreamEvent => ({ type: "alert", alert: alert(alertId, seq) });

describe("snapshotCursor", () => {
  it("es el máximo seq entre vehículos y alertas, comparado como entero", () => {
    expect(snapshotCursor([{ seq: "9" }, { seq: "100" }], [{ seq: "99" }])).toBe("100");
    expect(snapshotCursor([{ seq: "9" }], [{ seq: "9223372036854775807" }])).toBe("9223372036854775807");
  });

  it("sin nada es 0", () => {
    expect(snapshotCursor([], [])).toBe("0");
  });
});

describe("seqOf", () => {
  it("es el seq del estado o de la alerta", () => {
    expect(seqOf(stateEvent(randomUUID(), "5"))).toBe("5");
    expect(seqOf(alertEvent(randomUUID(), "6"))).toBe("6");
  });
});

describe("createSeqTracker", () => {
  it("acepta solo lo más nuevo que lo conocido de ESE vehículo, y los vehículos no se afectan entre sí", () => {
    const a = randomUUID();
    const b = randomUUID();
    const tracker = createSeqTracker({ vehicles: [state(a, "10"), state(b, "3")], alerts: [] });

    expect(tracker.accept(stateEvent(a, "10"))).toBe(false);
    expect(tracker.accept(stateEvent(a, "9"))).toBe(false);
    expect(tracker.accept(stateEvent(a, "11"))).toBe(true);
    expect(tracker.accept(stateEvent(b, "4"))).toBe(true);
  });

  it("un vehículo o alerta desconocidos siempre se aceptan la primera vez, y un repetido después no", () => {
    const tracker = createSeqTracker({ vehicles: [], alerts: [] });
    const v = randomUUID();
    const a = randomUUID();

    expect(tracker.accept(stateEvent(v, "1"))).toBe(true);
    expect(tracker.accept(stateEvent(v, "1"))).toBe(false);
    expect(tracker.accept(alertEvent(a, "1"))).toBe(true);
    expect(tracker.accept(alertEvent(a, "1"))).toBe(false);
  });

  it("la alerta se compara con la versión de SU alertId (el alta y la resolución toman seq distintos)", () => {
    const a = randomUUID();
    const tracker = createSeqTracker({ vehicles: [], alerts: [alert(a, "8")] });

    expect(tracker.accept(alertEvent(a, "8"))).toBe(false);
    expect(tracker.accept(alertEvent(a, "12"))).toBe(true);
    expect(tracker.accept(alertEvent(randomUUID(), "2"))).toBe(true);
  });

  it("compara los seq como enteros, no como texto", () => {
    const v = randomUUID();
    const tracker = createSeqTracker({ vehicles: [state(v, "9")], alerts: [] });

    expect(tracker.accept(stateEvent(v, "10"))).toBe(true);
  });

  it("un mismo id en vehículos y en alertas son entidades distintas", () => {
    const id = randomUUID();
    const tracker = createSeqTracker({ vehicles: [state(id, "50")], alerts: [] });

    expect(tracker.accept(alertEvent(id, "1"))).toBe(true);
  });
});
