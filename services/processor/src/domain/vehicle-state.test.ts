import { alertIdName } from "@fleet/contracts";
import { describe, expect, it } from "vitest";
import {
  advanceVehicle,
  DEFAULT_FLEET_RULES,
  selectFreshPoints,
  type FleetRules,
  type OpenAlert,
  type TrackedPoint,
  type VehicleAdvance,
  type VehicleSnapshot,
  type ZoneRef,
} from "./vehicle-state.js";

const VEHICLE = "a1c4e9d2-7b3f-4c58-8e16-0d9f2b6a4c71";
const CRITICAL: ZoneRef = { zoneId: "11111111-1111-4111-8111-111111111111", kind: "critical" };
const CRITICAL_B: ZoneRef = { zoneId: "00000000-0000-4000-8000-000000000b0b", kind: "critical" };
const DEPOT: ZoneRef = { zoneId: "22222222-2222-4222-8222-222222222222", kind: "depot" };

const T0 = Date.parse("2026-03-14T10:00:00.000Z");
const MINUTE = 60_000;
const at = (minutes: number, extraMs = 0) => new Date(T0 + minutes * MINUTE + extraMs).toISOString();

let counter = 0;
function point(minutes: number, overrides: Partial<TrackedPoint> = {}): TrackedPoint {
  counter += 1;
  return {
    eventId: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
    recordedAt: at(minutes),
    receivedAt: at(minutes, 2_000),
    lon: -75.5636,
    lat: 6.2518,
    speedMps: 0,
    headingDeg: null,
    mocked: false,
    lowAccuracy: false,
    zones: [],
    ...overrides,
  };
}
const moving = (minutes: number, overrides: Partial<TrackedPoint> = {}) => point(minutes, { speedMps: 8, ...overrides });
const stopped = (minutes: number, overrides: Partial<TrackedPoint> = {}) => point(minutes, { speedMps: 0, ...overrides });

const RULES: FleetRules = DEFAULT_FLEET_RULES;

function advance(previous: VehicleSnapshot | undefined, points: TrackedPoint[], openAlerts: OpenAlert[] = [], rules: FleetRules = RULES) {
  return advanceVehicle({ previous, points, openAlerts, rules });
}

function changed(result: VehicleAdvance) {
  if (!result.changed) throw new Error("se esperaba un cambio de estado");
  return result;
}

const snapshotOf = (overrides: Partial<VehicleSnapshot> = {}): VehicleSnapshot => ({
  recordedAt: at(0),
  receivedAt: at(0, 2_000),
  lon: -75.5636,
  lat: 6.2518,
  speedMps: 8,
  headingDeg: null,
  movement: "moving",
  stoppedSince: null,
  zoneIds: [],
  mocked: false,
  lowAccuracy: false,
  ...overrides,
});

describe("valores por defecto documentados", () => {
  it("0,5 m/s, 15 m y 20 minutos", () => {
    expect(DEFAULT_FLEET_RULES).toEqual({ stopSpeedMps: 0.5, stopDisplacementM: 15, criticalStopMinutes: 20 });
  });
});

describe("estado del vehículo: moving -> stopped -> moving", () => {
  it("el primer punto crea el estado: en movimiento si la velocidad es >= 0,5 m/s", () => {
    const result = changed(advance(undefined, [moving(0, { speedMps: 0.5 })]));

    expect(result.snapshot).toMatchObject({ movement: "moving", stoppedSince: null, speedMps: 0.5 });
  });

  it("detenido si la velocidad es < 0,5 m/s, con stoppedSince = recordedAt de ese punto (hora del fix, no la del servidor)", () => {
    const fix = stopped(3, { speedMps: 0.49 });

    const result = changed(advance(undefined, [fix]));

    expect(result.snapshot.movement).toBe("stopped");
    expect(result.snapshot.stoppedSince).toBe(fix.recordedAt);
    expect(result.snapshot.stoppedSince).not.toBe(fix.receivedAt);
  });

  it("moving -> stopped -> moving: stoppedSince es el primer punto detenido de la racha y vuelve a null al moverse", () => {
    const first = stopped(1);
    const result = changed(advance(undefined, [moving(0), first, stopped(2), stopped(3), moving(4)]));

    expect(result.snapshot).toMatchObject({ movement: "moving", stoppedSince: null });

    const midway = changed(advance(undefined, [moving(0), first, stopped(2), stopped(3)]));
    expect(midway.snapshot).toMatchObject({ movement: "stopped", stoppedSince: first.recordedAt });
  });

  it("la racha continúa entre tramos: con el estado previo detenido, stoppedSince no cambia", () => {
    const previous = snapshotOf({ movement: "stopped", stoppedSince: at(1), recordedAt: at(5) });

    const result = changed(advance(previous, [stopped(6), stopped(7)]));

    expect(result.snapshot).toMatchObject({ movement: "stopped", stoppedSince: at(1), recordedAt: at(7) });
  });

  it("una nueva detención después de moverse empieza otra racha", () => {
    const result = changed(advance(undefined, [stopped(0), moving(1), stopped(2), stopped(3)]));

    expect(result.snapshot.stoppedSince).toBe(at(2));
  });

  it("el estado final copia el último punto: posición, rumbo, receivedAt, mocked, lowAccuracy y zonas (ordenadas)", () => {
    const last = moving(2, { lon: -74.0721, lat: 4.711, headingDeg: 270, mocked: false, lowAccuracy: true, zones: [DEPOT, CRITICAL] });

    const result = changed(advance(undefined, [moving(1), last]));

    expect(result.snapshot).toMatchObject({
      lon: -74.0721,
      lat: 4.711,
      headingDeg: 270,
      receivedAt: last.receivedAt,
      lowAccuracy: true,
      zoneIds: [CRITICAL.zoneId, DEPOT.zoneId],
    });
  });

  it("ordena los puntos por recordedAt: un lote desordenado da el mismo estado", () => {
    const a = moving(0);
    const b = stopped(1);
    const c = stopped(2);

    const inOrder = changed(advance(undefined, [a, b, c]));
    const shuffled = changed(advance(undefined, [c, a, b]));

    expect(shuffled.snapshot).toEqual(inOrder.snapshot);
  });

  it("normaliza a UTC las horas con otro offset", () => {
    const local = stopped(0, { recordedAt: "2026-03-14T05:00:00.000-05:00", receivedAt: "2026-03-14T05:00:02.000-05:00" });

    const result = changed(advance(undefined, [local]));

    expect(result.snapshot.recordedAt).toBe("2026-03-14T10:00:00.000Z");
    expect(result.snapshot.stoppedSince).toBe("2026-03-14T10:00:00.000Z");
    expect(result.snapshot.receivedAt).toBe("2026-03-14T10:00:02.000Z");
  });

  it("la invariante del contrato: stoppedSince es null si y solo si el vehículo se mueve", () => {
    for (const points of [[moving(0)], [stopped(0)], [moving(0), stopped(1)], [stopped(0), moving(1)]]) {
      const { snapshot } = changed(advance(undefined, points));
      expect(snapshot.movement === "stopped").toBe(snapshot.stoppedSince !== null);
    }
  });
});

describe("puntos tardíos (sin regresión del estado)", () => {
  const previous = snapshotOf({ recordedAt: at(10), movement: "stopped", stoppedSince: at(8), speedMps: 0 });

  it("un punto con recordedAt anterior al del estado no lo modifica", () => {
    expect(advance(previous, [moving(5)])).toEqual({ changed: false });
  });

  it("un punto con recordedAt IGUAL al del estado tampoco (reentrega del mismo punto)", () => {
    expect(advance(previous, [moving(10)])).toEqual({ changed: false });
  });

  it("en un lote mixto solo cuentan los posteriores al estado", () => {
    const result = changed(advance(previous, [moving(5), stopped(11), moving(9)]));

    expect(result.snapshot).toMatchObject({ recordedAt: at(11), movement: "stopped", stoppedSince: at(8) });
  });

  it("un tardío no genera ni resuelve alertas", () => {
    const open: OpenAlert = { alertId: "alert-1", type: "mocked_location", zoneId: null, startedAt: at(9) };

    expect(advance(previous, [moving(5, { mocked: false })], [open])).toEqual({ changed: false });
  });

  it("dos puntos con el mismo recordedAt dentro del lote: solo el primero (por eventId) cuenta", () => {
    const a = stopped(1, { eventId: "00000000-0000-4000-8000-0000000000aa" });
    const b = moving(1, { eventId: "00000000-0000-4000-8000-0000000000bb" });

    const result = changed(advance(undefined, [b, a]));

    expect(result.snapshot.movement).toBe("stopped");
  });

  it("selectFreshPoints devuelve los puntos posteriores, ordenados y sin repetir instante", () => {
    const early = moving(1);
    const same = moving(10);
    const later = moving(12);
    const middle = moving(11);

    expect(selectFreshPoints(previous, [later, early, same, middle])).toEqual([middle, later]);
  });
});

describe("detención: desplazamiento cuando no hay velocidad", () => {
  const previous = snapshotOf({ recordedAt: at(0), lon: -75.5636, lat: 6.2518 });

  it("sin velocidad y a menos de 15 m del punto previo: detenido", () => {
    const result = changed(advance(previous, [point(1, { speedMps: null, lat: 6.2519 })]));

    expect(result.snapshot).toMatchObject({ movement: "stopped", stoppedSince: at(1) });
  });

  it("sin velocidad y a 15 m o más del punto previo: en movimiento (0,0002 grados de latitud son ~22 m)", () => {
    const result = changed(advance(previous, [point(1, { speedMps: null, lat: 6.2520 })]));

    expect(result.snapshot).toMatchObject({ movement: "moving", stoppedSince: null });
  });

  it("el punto previo es el anterior DEL MISMO lote cuando lo hay", () => {
    const result = changed(
      advance(undefined, [
        point(0, { speedMps: 5 }),
        point(1, { speedMps: null, lat: 6.2519 }),
        point(2, { speedMps: null, lat: 6.2519 }),
      ]),
    );

    expect(result.snapshot).toMatchObject({ movement: "stopped", stoppedSince: at(1) });
  });

  it("sin velocidad y sin punto previo no hay evidencia de detención: en movimiento", () => {
    const result = changed(advance(undefined, [point(0, { speedMps: null })]));

    expect(result.snapshot.movement).toBe("moving");
  });

  it("con velocidad, esta manda sobre el desplazamiento (parado en el sitio pero a 3 m/s: en movimiento)", () => {
    const result = changed(advance(previous, [point(1, { speedMps: 3 })]));

    expect(result.snapshot.movement).toBe("moving");
  });

  it("los umbrales son configurables", () => {
    const strict: FleetRules = { ...RULES, stopSpeedMps: 2, stopDisplacementM: 30 };

    expect(changed(advance(undefined, [point(0, { speedMps: 1.5 })], [], strict)).snapshot.movement).toBe("stopped");
    expect(changed(advance(previous, [point(1, { speedMps: null, lat: 6.2520 })], [], strict)).snapshot.movement).toBe("stopped");
  });
});

describe("alerta critical_zone_stop", () => {
  const stopRun = (untilMinutes: number, zones: ZoneRef[] = [CRITICAL]) => {
    const points: TrackedPoint[] = [];
    for (let minute = 0; minute <= untilMinutes; minute += 5) points.push(stopped(minute, { zones }));
    return points;
  };

  it("con 19 min 59,999 s detenido en zona crítica todavía no se levanta", () => {
    const points = [stopped(0, { zones: [CRITICAL] }), stopped(20, { zones: [CRITICAL], recordedAt: at(20, -1) })];

    expect(changed(advance(undefined, points)).raised).toEqual([]);
  });

  it("con EXACTAMENTE 20 minutos detenido en zona crítica se levanta (umbral inclusivo, contra la hora del fix)", () => {
    const result = changed(advance(undefined, stopRun(20)));

    expect(result.raised).toEqual([{ type: "critical_zone_stop", zoneId: CRITICAL.zoneId, startedAt: at(0), resolvedAt: null }]);
    expect(result.resolved).toEqual([]);
  });

  it("el umbral es configurable (ALERT_CRITICAL_STOP_MINUTES)", () => {
    const result = changed(advance(undefined, stopRun(10), [], { ...RULES, criticalStopMinutes: 10 }));

    expect(result.raised).toHaveLength(1);
  });

  it("la hora que cuenta es la del fix: puntos con recordedAt de hace horas pero procesados ahora", () => {
    const result = changed(advance(undefined, [stopped(0, { zones: [CRITICAL], receivedAt: at(1_000) }), stopped(20, { zones: [CRITICAL], receivedAt: at(1_000) })]));

    expect(result.raised).toHaveLength(1);
  });

  it("detenido 20 min en una zona que NO es crítica no levanta nada", () => {
    expect(changed(advance(undefined, stopRun(30, [DEPOT]))).raised).toEqual([]);
    expect(changed(advance(undefined, stopRun(30, []))).raised).toEqual([]);
  });

  it("20 min en una zona crítica pero en movimiento no levanta nada", () => {
    const points = [0, 5, 10, 15, 20].map((minute) => moving(minute, { zones: [CRITICAL] }));

    expect(changed(advance(undefined, points)).raised).toEqual([]);
  });

  it("no se levanta otra vez mientras haya una abierta (la del estado previo)", () => {
    const previous = snapshotOf({ movement: "stopped", stoppedSince: at(0), recordedAt: at(25), zoneIds: [CRITICAL.zoneId] });
    const open: OpenAlert = { alertId: "alert-1", type: "critical_zone_stop", zoneId: CRITICAL.zoneId, startedAt: at(0) };

    const result = changed(advance(previous, [stopped(26, { zones: [CRITICAL] }), stopped(27, { zones: [CRITICAL] })], [open]));

    expect(result.raised).toEqual([]);
    expect(result.resolved).toEqual([]);
  });

  it("si el estado previo ya lleva más de 20 min detenido y llega el primer punto, la levanta con startedAt = stoppedSince", () => {
    const previous = snapshotOf({ movement: "stopped", stoppedSince: at(0), recordedAt: at(15), zoneIds: [CRITICAL.zoneId] });

    const result = changed(advance(previous, [stopped(21, { zones: [CRITICAL] })]));

    expect(result.raised).toEqual([{ type: "critical_zone_stop", zoneId: CRITICAL.zoneId, startedAt: at(0), resolvedAt: null }]);
  });

  it("se resuelve al moverse: resolvedAt = recordedAt del primer punto en movimiento", () => {
    const previous = snapshotOf({ movement: "stopped", stoppedSince: at(0), recordedAt: at(25), zoneIds: [CRITICAL.zoneId] });
    const open: OpenAlert = { alertId: "alert-1", type: "critical_zone_stop", zoneId: CRITICAL.zoneId, startedAt: at(0) };

    const result = changed(advance(previous, [moving(26, { zones: [CRITICAL] }), moving(27, { zones: [CRITICAL] })], [open]));

    expect(result.resolved).toEqual([{ alertId: "alert-1", resolvedAt: at(26) }]);
    expect(result.raised).toEqual([]);
  });

  it("se resuelve al salir de la zona aunque siga detenido", () => {
    const previous = snapshotOf({ movement: "stopped", stoppedSince: at(0), recordedAt: at(25), zoneIds: [CRITICAL.zoneId] });
    const open: OpenAlert = { alertId: "alert-1", type: "critical_zone_stop", zoneId: CRITICAL.zoneId, startedAt: at(0) };

    const result = changed(advance(previous, [stopped(26, { zones: [] })], [open]));

    expect(result.resolved).toEqual([{ alertId: "alert-1", resolvedAt: at(26) }]);
  });

  it("levantada y resuelta en el mismo lote: sale como un alta que ya trae su resolución", () => {
    const result = changed(advance(undefined, [...stopRun(20), moving(25, { zones: [CRITICAL] })]));

    expect(result.raised).toEqual([{ type: "critical_zone_stop", zoneId: CRITICAL.zoneId, startedAt: at(0), resolvedAt: at(25) }]);
    expect(result.resolved).toEqual([]);
  });

  it("tras resolverse, una detención posterior es otra alerta (otro startedAt, otro alertId)", () => {
    const result = changed(advance(undefined, [...stopRun(20), moving(25, { zones: [CRITICAL] }), ...[30, 35, 40, 45, 50].map((minute) => stopped(minute, { zones: [CRITICAL] }))]));

    expect(result.raised.map((alert) => alert.startedAt)).toEqual([at(0), at(30)]);
    expect(result.raised.map((alert) => alert.resolvedAt)).toEqual([at(25), null]);
  });

  it("con varias zonas críticas elige la de menor zoneId (determinista)", () => {
    const result = changed(advance(undefined, stopRun(20, [CRITICAL, CRITICAL_B])));

    expect(result.raised[0]?.zoneId).toBe(CRITICAL_B.zoneId);
  });

  it("no vuelve a levantar la alerta que ya resolvió en este mismo lote (mismo startedAt) si el vehículo sigue detenido al reentrar a la zona", () => {
    const points = [...stopRun(20), stopped(21, { zones: [] }), stopped(22, { zones: [CRITICAL] }), stopped(23, { zones: [CRITICAL] })];

    const result = changed(advance(undefined, points));

    expect(result.raised).toHaveLength(1);
    expect(result.raised[0]).toMatchObject({ startedAt: at(0), resolvedAt: at(21) });
  });
});

describe("alerta mocked_location", () => {
  it("un punto con mocked=true la levanta, con startedAt = ese punto (el primero de la racha simulada)", () => {
    const first = moving(1, { mocked: true });

    const result = changed(advance(undefined, [moving(0), first, moving(2, { mocked: true }), moving(3, { mocked: true })]));

    expect(result.raised).toEqual([{ type: "mocked_location", zoneId: null, startedAt: first.recordedAt, resolvedAt: null }]);
    expect(result.snapshot.mocked).toBe(true);
  });

  it("no se repite mientras haya una abierta del estado previo", () => {
    const previous = snapshotOf({ mocked: true, recordedAt: at(3) });
    const open: OpenAlert = { alertId: "alert-m", type: "mocked_location", zoneId: null, startedAt: at(1) };

    const result = changed(advance(previous, [moving(4, { mocked: true })], [open]));

    expect(result.raised).toEqual([]);
    expect(result.resolved).toEqual([]);
  });

  it("se resuelve con el primer punto NO simulado (resolvedAt = su recordedAt)", () => {
    const previous = snapshotOf({ mocked: true, recordedAt: at(3) });
    const open: OpenAlert = { alertId: "alert-m", type: "mocked_location", zoneId: null, startedAt: at(1) };

    const result = changed(advance(previous, [moving(4, { mocked: true }), moving(5, { mocked: false }), moving(6, { mocked: false })], [open]));

    expect(result.resolved).toEqual([{ alertId: "alert-m", resolvedAt: at(5) }]);
    expect(result.snapshot.mocked).toBe(false);
  });

  it("racha simulada y resuelta dentro del mismo lote: un alta con su resolución", () => {
    const result = changed(advance(undefined, [moving(0), moving(1, { mocked: true }), moving(2, { mocked: false })]));

    expect(result.raised).toEqual([{ type: "mocked_location", zoneId: null, startedAt: at(1), resolvedAt: at(2) }]);
  });

  it("dos rachas simuladas separadas son dos alertas distintas", () => {
    const result = changed(
      advance(undefined, [moving(0, { mocked: true }), moving(1), moving(2, { mocked: true }), moving(3, { mocked: true })]),
    );

    expect(result.raised.map((alert) => alert.startedAt)).toEqual([at(0), at(2)]);
  });

  it("las dos alertas conviven: un vehículo simulado y detenido 20 min en zona crítica levanta ambas", () => {
    const points = [0, 5, 10, 15, 20].map((minute) => stopped(minute, { zones: [CRITICAL], mocked: true }));

    const result = changed(advance(undefined, points));

    expect(result.raised.map((alert) => alert.type).sort()).toEqual(["critical_zone_stop", "mocked_location"]);
  });
});

describe("alertId determinista", () => {
  it("reprocesar los mismos puntos da las mismas altas (mismo vehículo, tipo y startedAt): el nombre del uuid v5 no cambia", () => {
    const points = [0, 5, 10, 15, 20].map((minute) => stopped(minute, { zones: [CRITICAL] }));

    const first = changed(advance(undefined, points));
    const second = changed(advance(undefined, [...points].reverse()));

    expect(second.raised).toEqual(first.raised);
    const names = first.raised.map((alert) => alertIdName(VEHICLE, alert.type, alert.startedAt));
    expect(names).toEqual(second.raised.map((alert) => alertIdName(VEHICLE, alert.type, alert.startedAt)));
    expect(names[0]).toBe(`${VEHICLE}|critical_zone_stop|${at(0)}`);
  });

  it("el mismo instante con otro offset produce el mismo nombre", () => {
    expect(alertIdName(VEHICLE, "mocked_location", "2026-03-14T05:00:00.000-05:00")).toBe(alertIdName(VEHICLE, "mocked_location", at(0)));
  });
});

describe("sin puntos nuevos", () => {
  it("una lista vacía no cambia nada", () => {
    expect(advance(snapshotOf(), [])).toEqual({ changed: false });
    expect(advance(undefined, [])).toEqual({ changed: false });
  });
});
