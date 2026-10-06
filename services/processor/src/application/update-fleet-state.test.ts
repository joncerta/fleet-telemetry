import { alertEventSchema, alertIdName, vehicleStateEventSchema, type Alert, type TelemetryRawEvent, type VehicleState } from "@fleet/contracts";
import { describe, expect, it } from "vitest";
import { DEFAULT_FLEET_RULES, type FleetRules, type OpenAlert, type VehicleSnapshot, type ZoneRef } from "../domain/vehicle-state.js";
import type {
  AlertIdGenerator,
  AlertResolutionWrite,
  AlertWrite,
  FleetEventPublisher,
  FleetEvents,
  FleetStateTransaction,
  FleetStateUnitOfWork,
  ProcessorLogger,
  PublishableFleet,
  VehicleStateWrite,
} from "./ports.js";
import { createUpdateFleetState, mergeFleetUpdates, type FleetTelemetry } from "./update-fleet-state.js";

const TENANT_A = "9d7e1b34-2a6c-4f08-b5d3-6e4a8c1f0b92";
const TENANT_B = "3c5f0a71-8d2e-4b96-a1f7-5e8d3b2c6a40";
const DEVICE = "5b8a3f6c-1e9d-4a27-8c40-7f2e6d1b9a35";
const VEHICLE_1 = "a1c4e9d2-7b3f-4c58-8e16-0d9f2b6a4c71";
const VEHICLE_2 = "b2d5f0e3-8c4a-4d69-9f27-1e0a3c7b5d82";
const CRITICAL: ZoneRef = { zoneId: "11111111-1111-4111-8111-111111111111", kind: "critical" };
const NOW = new Date("2026-03-14T12:00:00.000Z");
const T0 = Date.parse("2026-03-14T10:00:00.000Z");
const MINUTE = 60_000;
const at = (minutes: number) => new Date(T0 + minutes * MINUTE).toISOString();

let counter = 0;
function telemetry(
  vehicleId: string,
  minutes: number,
  options: { tenantId?: string; speedMps?: number | null; mocked?: boolean; lon?: number; correlationId?: string } = {},
): FleetTelemetry {
  counter += 1;
  const event: TelemetryRawEvent = {
    schemaVersion: 1,
    tenantId: options.tenantId ?? TENANT_A,
    deviceId: DEVICE,
    receivedAt: new Date(T0 + minutes * MINUTE + 2_000).toISOString(),
    point: {
      eventId: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
      vehicleId,
      recordedAt: at(minutes),
      lon: options.lon ?? -75.5636,
      lat: 6.2518,
      speedMps: options.speedMps === undefined ? 0 : options.speedMps,
      headingDeg: null,
      accuracyM: 5,
      mocked: options.mocked ?? false,
      lowAccuracy: false,
    },
  };
  return { event, correlationId: options.correlationId ?? `corr-${counter}` };
}

class Timeline {
  readonly events: string[] = [];
  add(event: string) {
    this.events.push(event);
  }
}

interface StoredAlert {
  alertId: string;
  tenantId: string;
  vehicleId: string;
  type: AlertWrite["type"];
  zoneId: string | null;
  startedAt: string;
  raisedAt: string;
  resolvedAt: string | null;
  seq: number;
}
interface StoredState {
  tenantId: string;
  snapshot: VehicleSnapshot;
  seq: number;
}

/** Calls registrados por puerto, siempre con el tenant que recibió. */
interface Call {
  op: string;
  tenantId: string;
  vehicleIds?: readonly string[];
  detail?: unknown;
}

/** Base en memoria con la semántica de las tablas: una fila por vehículo, alertas únicas por id y `seq` global creciente. */
class FakeStore implements FleetStateUnitOfWork {
  readonly states = new Map<string, StoredState>();
  readonly alerts = new Map<string, StoredAlert>();
  readonly calls: Call[] = [];
  runs = 0;
  inTransaction = false;
  seq = 0;
  /** Zonas que contiene cada posición, por longitud (la longitud identifica el "lugar" en los tests). */
  zonesByLon = new Map<number, ZoneRef[]>();
  failOn: string | undefined;
  failure = new Error("la base no responde");

  constructor(private readonly timeline: Timeline) {}

  async run<T>(work: (tx: FleetStateTransaction) => Promise<T>): Promise<T> {
    this.runs += 1;
    this.inTransaction = true;
    this.timeline.add("tx:begin");
    // Una transacción real revierte lo escrito si `work` lanza: se trabaja sobre una copia y se confirma al final.
    const snapshot = { states: new Map(this.states), alerts: new Map([...this.alerts].map(([id, alert]) => [id, { ...alert }])), seq: this.seq };
    try {
      const result = await work(this.transaction());
      this.timeline.add("tx:commit");
      return result;
    } catch (error) {
      this.states.clear();
      for (const [key, value] of snapshot.states) this.states.set(key, value);
      this.alerts.clear();
      for (const [key, value] of snapshot.alerts) this.alerts.set(key, value);
      this.seq = snapshot.seq;
      this.timeline.add("tx:rollback");
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  private maybeFail(op: string): void {
    if (this.failOn === op) throw this.failure;
  }

  private transaction(): FleetStateTransaction {
    const record = (call: Call) => {
      if (!this.inTransaction) throw new Error("operación fuera de la transacción");
      this.calls.push(call);
      this.timeline.add(call.op);
    };
    return {
      lockVehicleStates: (tenantId, vehicleIds) => {
        record({ op: "lockVehicleStates", tenantId, vehicleIds });
        this.maybeFail("lockVehicleStates");
        const found = new Map<string, VehicleSnapshot>();
        for (const id of vehicleIds) {
          const stored = this.states.get(id);
          if (stored !== undefined && stored.tenantId === tenantId) found.set(id, stored.snapshot);
        }
        return Promise.resolve(found);
      },
      lockOpenAlerts: (tenantId, vehicleIds) => {
        record({ op: "lockOpenAlerts", tenantId, vehicleIds });
        const byVehicle = new Map<string, OpenAlert[]>();
        for (const alert of this.alerts.values()) {
          if (alert.tenantId !== tenantId || alert.resolvedAt !== null || !vehicleIds.includes(alert.vehicleId)) continue;
          byVehicle.set(alert.vehicleId, [
            ...(byVehicle.get(alert.vehicleId) ?? []),
            { alertId: alert.alertId, type: alert.type, zoneId: alert.zoneId, startedAt: alert.startedAt },
          ]);
        }
        return Promise.resolve(byVehicle);
      },
      zonesCovering: (tenantId, positions) => {
        record({ op: "zonesCovering", tenantId, detail: positions.length });
        this.maybeFail("zonesCovering");
        return Promise.resolve(positions.map((position) => this.zonesByLon.get(position.lon) ?? []));
      },
      upsertVehicleStates: (tenantId, states: readonly VehicleStateWrite[]) => {
        record({ op: "upsertVehicleStates", tenantId, vehicleIds: states.map((state) => state.vehicleId), detail: states });
        this.maybeFail("upsertVehicleStates");
        for (const { vehicleId, snapshot } of states) {
          this.seq += 1;
          this.states.set(vehicleId, { tenantId, snapshot, seq: this.seq });
        }
        return Promise.resolve();
      },
      insertAlerts: (tenantId, alerts: readonly AlertWrite[]) => {
        record({ op: "insertAlerts", tenantId, detail: alerts });
        const inserted: string[] = [];
        for (const alert of alerts) {
          if (this.alerts.has(alert.alertId)) continue;
          this.seq += 1;
          this.alerts.set(alert.alertId, { ...alert, tenantId, seq: this.seq });
          inserted.push(alert.alertId);
        }
        return Promise.resolve(inserted);
      },
      resolveAlerts: (tenantId, resolutions: readonly AlertResolutionWrite[]) => {
        record({ op: "resolveAlerts", tenantId, detail: resolutions });
        const resolved: string[] = [];
        for (const { alertId, resolvedAt } of resolutions) {
          const alert = this.alerts.get(alertId);
          if (alert === undefined || alert.tenantId !== tenantId || alert.resolvedAt !== null) continue;
          this.seq += 1;
          alert.resolvedAt = resolvedAt;
          alert.seq = this.seq;
          resolved.push(alertId);
        }
        return Promise.resolve(resolved);
      },
      readPublishable: (tenantId, query): Promise<PublishableFleet> => {
        record({ op: "readPublishable", tenantId, vehicleIds: query.vehicleIds, detail: query.alertsSince });
        this.maybeFail("readPublishable");
        const states: VehicleState[] = [];
        for (const vehicleId of query.vehicleIds) {
          const stored = this.states.get(vehicleId);
          if (stored === undefined || stored.tenantId !== tenantId) continue;
          states.push({
            vehicleId,
            plate: `PLATE-${vehicleId.slice(0, 4)}`,
            lon: stored.snapshot.lon,
            lat: stored.snapshot.lat,
            recordedAt: stored.snapshot.recordedAt,
            receivedAt: stored.snapshot.receivedAt,
            speedMps: stored.snapshot.speedMps,
            headingDeg: stored.snapshot.headingDeg,
            movement: stored.snapshot.movement,
            stoppedSince: stored.snapshot.stoppedSince,
            zoneIds: [...stored.snapshot.zoneIds],
            mocked: stored.snapshot.mocked,
            lowAccuracy: stored.snapshot.lowAccuracy,
            seq: String(stored.seq),
          });
        }
        const alerts: Alert[] = [];
        for (const alert of this.alerts.values()) {
          if (alert.tenantId !== tenantId || !query.vehicleIds.includes(alert.vehicleId)) continue;
          if (alert.resolvedAt !== null && Date.parse(alert.resolvedAt) < Date.parse(query.alertsSince)) continue;
          alerts.push({
            alertId: alert.alertId,
            vehicleId: alert.vehicleId,
            plate: `PLATE-${alert.vehicleId.slice(0, 4)}`,
            type: alert.type,
            zoneId: alert.zoneId,
            zoneName: alert.zoneId === null ? null : "Zona crítica",
            startedAt: alert.startedAt,
            raisedAt: alert.raisedAt,
            resolvedAt: alert.resolvedAt,
            seq: String(alert.seq),
          });
        }
        return Promise.resolve({ states, alerts });
      },
    };
  }
}

class FakePublisher implements FleetEventPublisher {
  readonly published: FleetEvents[] = [];
  failure: Error | undefined;
  constructor(private readonly timeline: Timeline) {}
  publish(events: FleetEvents): Promise<void> {
    this.timeline.add("publish");
    if (this.failure !== undefined) return Promise.reject(this.failure);
    this.published.push(events);
    return Promise.resolve();
  }
}

/** No es un v5 real (eso lo prueba el adaptador): solo determinista, para ver QUÉ nombre recibe. */
const fakeAlertIds: AlertIdGenerator & { readonly names: string[] } = {
  names: [],
  generate(name) {
    this.names.push(name);
    let hash = 0;
    for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return `00000000-0000-5000-8000-${hash.toString(16).padStart(12, "0").slice(-12)}`;
  },
};

function setup(options: { rules?: FleetRules } = {}) {
  const timeline = new Timeline();
  const store = new FakeStore(timeline);
  const publisher = new FakePublisher(timeline);
  const logs: { level: string; fields: Record<string, unknown>; message: string }[] = [];
  const logger: ProcessorLogger = {
    info: (fields, message) => logs.push({ level: "info", fields, message }),
    warn: (fields, message) => logs.push({ level: "warn", fields, message }),
    error: (fields, message) => logs.push({ level: "error", fields, message }),
  };
  const useCase = createUpdateFleetState({
    unitOfWork: store,
    publisher,
    alertIds: fakeAlertIds,
    clock: { now: () => NOW },
    logger,
    rules: options.rules ?? DEFAULT_FLEET_RULES,
  });
  return { timeline, store, publisher, logs, useCase };
}

describe("updateFleetState.apply", () => {
  describe("camino feliz", () => {
    it("el primer lote crea el estado del vehículo y lo devuelve como evento vehicle.state con key, tenant y correlationId del mensaje original", async () => {
      const { useCase, store } = setup();

      const update = await useCase.apply([telemetry(VEHICLE_1, 0, { speedMps: 8 }), telemetry(VEHICLE_1, 1, { speedMps: 8, correlationId: "corr-ultimo" })]);

      expect(store.states.get(VEHICLE_1)?.snapshot).toMatchObject({ movement: "moving", stoppedSince: null, recordedAt: at(1) });
      expect(update.vehicleStates).toHaveLength(1);
      const [entry] = update.vehicleStates;
      expect(entry?.key).toBe(VEHICLE_1);
      // El correlationId es el del ÚLTIMO mensaje del vehículo en el tramo: el que fijó el estado publicado.
      expect(entry?.correlationId).toBe("corr-ultimo");
      expect(entry?.event).toMatchObject({ schemaVersion: 1, tenantId: TENANT_A, state: { vehicleId: VEHICLE_1, movement: "moving", seq: "1" } });
      // El evento cumple el contrato estricto.
      expect(vehicleStateEventSchema.safeParse(entry?.event).success).toBe(true);
      expect(update.alerts).toEqual([]);
    });

    it("detenido: stoppedSince es el recordedAt del primer punto detenido (hora del fix)", async () => {
      const { useCase } = setup();

      const update = await useCase.apply([telemetry(VEHICLE_1, 0, { speedMps: 8 }), telemetry(VEHICLE_1, 1), telemetry(VEHICLE_1, 2)]);

      expect(update.vehicleStates[0]?.event.state).toMatchObject({ movement: "stopped", stoppedSince: at(1) });
    });

    it("todo el tramo va en UNA transacción: bloquea el estado, consulta las zonas, escribe y lee lo que publica, en ese orden", async () => {
      const { useCase, store, timeline } = setup();

      await useCase.apply([telemetry(VEHICLE_1, 0), telemetry(VEHICLE_2, 0)]);

      expect(store.runs).toBe(1);
      expect(timeline.events).toEqual([
        "tx:begin",
        "lockVehicleStates",
        "lockOpenAlerts",
        "zonesCovering",
        "upsertVehicleStates",
        "readPublishable",
        "tx:commit",
      ]);
    });

    it("la hora del servidor es la del reloj inyectado (raisedAt), no la de los puntos", async () => {
      const { useCase, store } = setup();
      store.zonesByLon.set(-75.5, [CRITICAL]);

      await useCase.apply([0, 5, 10, 15, 20].map((minutes) => telemetry(VEHICLE_1, minutes, { lon: -75.5 })));

      expect([...store.alerts.values()][0]?.raisedAt).toBe(NOW.toISOString());
    });
  });

  describe("alertas", () => {
    const stopInZone = (): FleetTelemetry[] => [0, 5, 10, 15, 20].map((minutes) => telemetry(VEHICLE_1, minutes, { lon: -75.5 }));

    it("20 minutos detenido en una zona crítica: inserta la alerta con alertId = uuidv5(alertIdName(...)) y la publica en fleet.alerts", async () => {
      const { useCase, store } = setup();
      store.zonesByLon.set(-75.5, [CRITICAL]);

      const update = await useCase.apply(stopInZone());

      const expectedName = alertIdName(VEHICLE_1, "critical_zone_stop", at(0));
      expect(fakeAlertIds.names).toContain(expectedName);
      expect(store.alerts.size).toBe(1);
      const stored = [...store.alerts.values()][0];
      expect(stored).toMatchObject({ vehicleId: VEHICLE_1, tenantId: TENANT_A, type: "critical_zone_stop", zoneId: CRITICAL.zoneId, startedAt: at(0), resolvedAt: null });
      expect(update.alerts).toHaveLength(1);
      expect(update.alerts[0]?.key).toBe(VEHICLE_1);
      expect(update.alerts[0]?.event).toMatchObject({
        schemaVersion: 1,
        tenantId: TENANT_A,
        alert: { type: "critical_zone_stop", zoneName: "Zona crítica", resolvedAt: null, startedAt: at(0) },
      });
      expect(alertEventSchema.safeParse(update.alerts[0]?.event).success).toBe(true);
    });

    it("al moverse la resuelve: la alerta queda con resolvedAt = recordedAt del primer punto en movimiento, y se publica con el seq nuevo", async () => {
      const { useCase, store } = setup();
      store.zonesByLon.set(-75.5, [CRITICAL]);
      const first = await useCase.apply(stopInZone());
      const raisedSeq = Number(first.alerts[0]?.event.alert.seq);

      const second = await useCase.apply([telemetry(VEHICLE_1, 25, { lon: -75.5, speedMps: 9 })]);

      expect(second.alerts).toHaveLength(1);
      expect(second.alerts[0]?.event.alert).toMatchObject({ resolvedAt: at(25) });
      expect(Number(second.alerts[0]?.event.alert.seq)).toBeGreaterThan(raisedSeq);
      expect(second.vehicleStates[0]?.event.state).toMatchObject({ movement: "moving", stoppedSince: null });
    });

    it("mocked_location: un punto simulado la levanta y el primero no simulado la resuelve", async () => {
      const { useCase } = setup();

      const raised = await useCase.apply([telemetry(VEHICLE_1, 0, { speedMps: 8, mocked: true })]);
      expect(raised.alerts[0]?.event.alert).toMatchObject({ type: "mocked_location", zoneId: null, zoneName: null, startedAt: at(0), resolvedAt: null });

      const resolved = await useCase.apply([telemetry(VEHICLE_1, 1, { speedMps: 8, mocked: false })]);
      expect(resolved.alerts[0]?.event.alert).toMatchObject({ type: "mocked_location", resolvedAt: at(1) });
    });

    it("una alerta levantada y resuelta dentro del mismo tramo se inserta ya resuelta, con un solo evento", async () => {
      const { useCase, store } = setup();

      const update = await useCase.apply([telemetry(VEHICLE_1, 0, { speedMps: 8 }), telemetry(VEHICLE_1, 1, { speedMps: 8, mocked: true }), telemetry(VEHICLE_1, 2, { speedMps: 8 })]);

      expect([...store.alerts.values()][0]).toMatchObject({ startedAt: at(1), resolvedAt: at(2) });
      expect(update.alerts).toHaveLength(1);
      expect(update.alerts[0]?.event.alert.resolvedAt).toBe(at(2));
    });

    it("reprocesar el mismo tramo no duplica la alerta (mismo alertId, ON CONFLICT DO NOTHING) ni cambia la que existe", async () => {
      const { useCase, store } = setup();
      store.zonesByLon.set(-75.5, [CRITICAL]);
      const batch = stopInZone();
      await useCase.apply(batch);
      const before = JSON.stringify([...store.alerts.values()]);

      await useCase.apply(batch);

      expect(store.alerts.size).toBe(1);
      expect(JSON.stringify([...store.alerts.values()])).toBe(before);
    });
  });

  describe("reentrega y puntos tardíos", () => {
    it("reentregar el mismo tramo no escribe estado nuevo (todos sus puntos son tardíos) pero REPUBLICA el estado vigente con el mismo seq", async () => {
      const { useCase, store } = setup();
      const batch = [telemetry(VEHICLE_1, 0, { speedMps: 8 }), telemetry(VEHICLE_1, 1)];
      const first = await useCase.apply(batch);
      const writesBefore = store.calls.filter((call) => call.op === "upsertVehicleStates").length;

      const again = await useCase.apply(batch);

      expect(store.calls.filter((call) => call.op === "upsertVehicleStates").length).toBe(writesBefore);
      expect(again.vehicleStates).toHaveLength(1);
      expect(again.vehicleStates[0]?.event).toEqual(first.vehicleStates[0]?.event);
    });

    it("tras un crash entre el commit y la publicación, la reentrega vuelve a publicar la alerta que ya estaba en la base", async () => {
      const { useCase, store } = setup();
      store.zonesByLon.set(-75.5, [CRITICAL]);
      const batch = [0, 5, 10, 15, 20].map((minutes) => telemetry(VEHICLE_1, minutes, { lon: -75.5 }));
      const lost = await useCase.apply(batch);
      // (la publicación de `lost` nunca ocurrió: se simula descartándola)

      const again = await useCase.apply(batch);

      expect(again.alerts.map((entry) => entry.event.alert.alertId)).toEqual(lost.alerts.map((entry) => entry.event.alert.alertId));
    });

    it("tras un crash, la reentrega también republica la RESOLUCIÓN: alertsSince es el primer recordedAt del tramo", async () => {
      const { useCase, store } = setup();
      store.zonesByLon.set(-75.5, [CRITICAL]);
      await useCase.apply([0, 5, 10, 15, 20].map((minutes) => telemetry(VEHICLE_1, minutes, { lon: -75.5 })));
      const resolvingBatch = [telemetry(VEHICLE_1, 25, { lon: -75.5, speedMps: 9 }), telemetry(VEHICLE_1, 26, { lon: -75.5, speedMps: 9 })];
      await useCase.apply(resolvingBatch);

      const again = await useCase.apply(resolvingBatch);

      expect(again.alerts).toHaveLength(1);
      expect(again.alerts[0]?.event.alert.resolvedAt).toBe(at(25));
      expect(store.calls.filter((call) => call.op === "readPublishable").at(-1)?.detail).toBe(at(25));
    });

    it("un punto tardío no hace retroceder el estado: se persistió en telemetry pero el estado no cambia", async () => {
      const { useCase, store } = setup();
      await useCase.apply([telemetry(VEHICLE_1, 10, { speedMps: 8 })]);
      const before = store.states.get(VEHICLE_1);

      await useCase.apply([telemetry(VEHICLE_1, 5)]);

      expect(store.states.get(VEHICLE_1)).toBe(before);
    });

    it("un tramo con un vehículo al día y otro nuevo escribe solo el que cambia, y publica a los dos", async () => {
      const { useCase, store } = setup();
      await useCase.apply([telemetry(VEHICLE_1, 0, { speedMps: 8 })]);
      store.calls.length = 0;

      const update = await useCase.apply([telemetry(VEHICLE_1, 0, { speedMps: 8 }), telemetry(VEHICLE_2, 0, { speedMps: 8 })]);

      expect(store.calls.find((call) => call.op === "upsertVehicleStates")?.vehicleIds).toEqual([VEHICLE_2]);
      expect(update.vehicleStates.map((entry) => entry.key).sort()).toEqual([VEHICLE_1, VEHICLE_2].sort());
    });
  });

  describe("tenant (regla 4)", () => {
    it("un lote con dos tenants pasa a CADA puerto el tenant del evento y nunca mezcla vehículos entre ellos", async () => {
      const { useCase, store } = setup();

      const update = await useCase.apply([telemetry(VEHICLE_1, 0, { tenantId: TENANT_A }), telemetry(VEHICLE_2, 0, { tenantId: TENANT_B })]);

      expect(store.runs).toBe(1);
      for (const call of store.calls) {
        if (call.vehicleIds === undefined) continue;
        const expectedTenant = call.vehicleIds.includes(VEHICLE_1) ? TENANT_A : TENANT_B;
        expect(call.tenantId).toBe(expectedTenant);
        expect(call.vehicleIds).toHaveLength(1);
      }
      expect(new Set(store.calls.map((call) => call.tenantId))).toEqual(new Set([TENANT_A, TENANT_B]));
      expect(update.vehicleStates.find((entry) => entry.key === VEHICLE_1)?.event.tenantId).toBe(TENANT_A);
      expect(update.vehicleStates.find((entry) => entry.key === VEHICLE_2)?.event.tenantId).toBe(TENANT_B);
    });

    it("cada operación de la transacción (bloqueo, zonas, escritura, lectura) lleva el tenant", async () => {
      const { useCase, store } = setup();

      await useCase.apply([telemetry(VEHICLE_1, 0, { tenantId: TENANT_B })]);

      expect(store.calls.map((call) => call.op)).toEqual(["lockVehicleStates", "lockOpenAlerts", "zonesCovering", "upsertVehicleStates", "readPublishable"]);
      expect(store.calls.every((call) => call.tenantId === TENANT_B)).toBe(true);
    });

    it("el estado de un vehículo de otro tenant no se ve como previo (la base filtra por tenant)", async () => {
      const { useCase, store } = setup();
      await useCase.apply([telemetry(VEHICLE_1, 10, { tenantId: TENANT_A, speedMps: 8 })]);

      // Mismo vehicleId bajo otro tenant: no hay estado previo para ese tenant, así que no es "tardío".
      const update = await useCase.apply([telemetry(VEHICLE_1, 5, { tenantId: TENANT_B, speedMps: 8 })]);

      expect(store.calls.filter((call) => call.op === "upsertVehicleStates").at(-1)?.tenantId).toBe(TENANT_B);
      expect(update.vehicleStates).toHaveLength(1);
    });
  });

  describe("fallos: se propagan, nunca se tragan", () => {
    it.each(["lockVehicleStates", "zonesCovering", "upsertVehicleStates", "readPublishable"])("si falla %s, apply rechaza con ese error y la transacción se revierte", async (op) => {
      const { useCase, store, timeline } = setup();
      store.failOn = op;

      await expect(useCase.apply([telemetry(VEHICLE_1, 0)])).rejects.toBe(store.failure);

      expect(timeline.events.at(-1)).toBe("tx:rollback");
      expect(store.states.size).toBe(0);
    });

    it("sin puntos no abre transacción", async () => {
      const { useCase, store } = setup();

      const update = await useCase.apply([]);

      expect(store.runs).toBe(0);
      expect(update).toMatchObject({ vehicleStates: [], alerts: [] });
    });
  });

  describe("logs", () => {
    it("registra conteos y las alertas levantadas con sus ids, sin coordenadas ni placas", async () => {
      const { useCase, store, logs } = setup();
      store.zonesByLon.set(-75.123456, [CRITICAL]);

      await useCase.apply([0, 5, 10, 15, 20].map((minutes) => telemetry(VEHICLE_1, minutes, { lon: -75.123456, correlationId: "corr-log" })));

      const raised = logs.find((line) => line.message.includes("Alerta levantada"));
      expect(raised?.fields).toMatchObject({ tenantId: TENANT_A, vehicleId: VEHICLE_1, type: "critical_zone_stop", correlationId: "corr-log" });
      const text = JSON.stringify(logs);
      expect(text).not.toContain("75.123456");
      expect(text).not.toContain("6.2518");
      expect(text).not.toContain("PLATE-");
    });
  });
});

describe("updateFleetState.publish", () => {
  it("entrega al publicador los eventos de vehicle.state y de fleet.alerts del tramo", async () => {
    const { useCase, publisher } = setup();
    const update = await useCase.apply([telemetry(VEHICLE_1, 0, { speedMps: 8, mocked: true })]);

    await useCase.publish(update);

    expect(publisher.published).toHaveLength(1);
    expect(publisher.published[0]?.vehicleStates).toHaveLength(1);
    expect(publisher.published[0]?.alerts).toHaveLength(1);
  });

  it("si el publicador falla, publish rechaza con el mismo error", async () => {
    const { useCase, publisher } = setup();
    publisher.failure = new Error("el broker no confirmó");
    const update = await useCase.apply([telemetry(VEHICLE_1, 0)]);

    await expect(useCase.publish(update)).rejects.toBe(publisher.failure);
  });

  it("sin eventos no llama al publicador", async () => {
    const { useCase, publisher } = setup();

    await useCase.publish(await useCase.apply([]));

    expect(publisher.published).toEqual([]);
  });

  it("mergeFleetUpdates junta los eventos de varios avances", async () => {
    const { useCase } = setup();
    const a = await useCase.apply([telemetry(VEHICLE_1, 0)]);
    const b = await useCase.apply([telemetry(VEHICLE_2, 0)]);

    const merged = mergeFleetUpdates([a, b]);

    expect(merged.vehicleStates.map((entry) => entry.key)).toEqual([VEHICLE_1, VEHICLE_2]);
    expect(merged.stats).toEqual({
      vehicles: a.stats.vehicles + b.stats.vehicles,
      statesWritten: a.stats.statesWritten + b.stats.statesWritten,
      alertsRaised: a.stats.alertsRaised + b.stats.alertsRaised,
      alertsResolved: a.stats.alertsResolved + b.stats.alertsResolved,
    });
  });
});
