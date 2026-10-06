import { randomUUID } from "node:crypto";
import type { TelemetryRawEvent } from "@fleet/contracts";
import { createLogger, createPool, databaseAdminConfig, defaultMigrationsDir, loadConfig, migrate } from "@fleet/platform";
import { createTempDatabase, type TempDatabase } from "@fleet/platform/testing";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createUpdateFleetState } from "../application/update-fleet-state.js";
import type { FleetEvents, FleetStateUnitOfWork } from "../application/ports.js";
import { DEFAULT_FLEET_RULES, type VehicleSnapshot } from "../domain/vehicle-state.js";
import { classifyFailure } from "../domain/failure-classification.js";
import { createPgFleetStateUnitOfWork } from "./pg-fleet-state-store.js";
import { createAlertIdGenerator } from "./uuid-v5-alert-ids.js";

// Contra TimescaleDB/PostGIS real, sobre una base temporal con las migraciones reales y con el rol de los servicios (fleet_app): el UPSERT
// con seq explícito, las claves foráneas compuestas por tenant, ST_Covers sobre una zona sembrada, las alertas idempotentes y los
// bloqueos FOR UPDATE se prueban con SQL de verdad (los fakes no los detectan).
const config = loadConfig(z.object(databaseAdminConfig.shape));
const logger = createLogger({ service: "processor-fleet-state-it", level: "error" });
const rolePasswords = { fleet_app: config.FLEET_APP_PASSWORD, fleet_ro: config.FLEET_RO_PASSWORD };

let db: TempDatabase;
let pool: Pool;
let unitOfWork: FleetStateUnitOfWork;

beforeAll(async () => {
  db = await createTempDatabase(config.DATABASE_ADMIN_URL);
  await migrate({ adminUrl: db.adminUrl, migrationsDir: defaultMigrationsDir, rolePasswords, logger });
  pool = createPool({ connectionString: db.urlFor("fleet_app", rolePasswords.fleet_app), applicationName: "processor-fleet-state-it", logger, max: 6 });
  unitOfWork = createPgFleetStateUnitOfWork(pool);
});

afterAll(async () => {
  await pool?.end();
  await db?.drop();
});

const MINUTE = 60_000;
/** Instantes recientes y redondeados al segundo. */
const BASE_MS = Math.floor(Date.now() / 1_000) * 1_000 - 2 * 3_600_000;
const at = (minutes: number) => new Date(BASE_MS + minutes * MINUTE).toISOString();

// Rectángulo de ~1 km alrededor de Medellín (lon -75.57..-75.56, lat 6.25..6.26).
const RECTANGLE = "POLYGON((-75.57 6.25, -75.56 6.25, -75.56 6.26, -75.57 6.26, -75.57 6.25))";
const INSIDE = { lon: -75.565, lat: 6.255 };
const ON_EDGE = { lon: -75.57, lat: 6.255 };
const OUTSIDE = { lon: -75.5, lat: 6.255 };

interface Scope {
  tenantId: string;
  vehicleId: string;
  criticalZoneId: string;
  depotZoneId: string;
}

/** Un tenant con un vehículo y dos zonas que se solapan en el mismo rectángulo (una crítica y un depósito). */
async function seedScope(label: string): Promise<Scope> {
  const scope: Scope = { tenantId: randomUUID(), vehicleId: randomUUID(), criticalZoneId: randomUUID(), depotZoneId: randomUUID() };
  await pool.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [scope.tenantId, `it-${label}-${scope.tenantId.slice(0, 8)}`]);
  await pool.query("INSERT INTO vehicles (id, tenant_id, plate) VALUES ($1, $2, $3)", [scope.vehicleId, scope.tenantId, `P${scope.vehicleId.slice(0, 5).toUpperCase()}`]);
  await pool.query("INSERT INTO zones (zone_id, tenant_id, name, kind, geom) VALUES ($1, $2, $3, 'critical', ST_GeomFromText($4, 4326))", [
    scope.criticalZoneId,
    scope.tenantId,
    `Zona crítica ${label}`,
    RECTANGLE,
  ]);
  await pool.query("INSERT INTO zones (zone_id, tenant_id, name, kind, geom) VALUES ($1, $2, $3, 'depot', ST_GeomFromText($4, 4326))", [
    scope.depotZoneId,
    scope.tenantId,
    `Depósito ${label}`,
    RECTANGLE,
  ]);
  return scope;
}

const snapshotOf = (minutes: number, overrides: Partial<VehicleSnapshot> = {}): VehicleSnapshot => ({
  recordedAt: at(minutes),
  receivedAt: at(minutes + 1),
  lon: INSIDE.lon,
  lat: INSIDE.lat,
  speedMps: 8,
  headingDeg: 90,
  movement: "moving",
  stoppedSince: null,
  zoneIds: [],
  mocked: false,
  lowAccuracy: false,
  ...overrides,
});

const alertId = () => randomUUID();

const seqOf = async (scope: Scope): Promise<bigint> => {
  const { rows } = await pool.query<{ seq: string }>("SELECT seq::text AS seq FROM vehicle_state WHERE tenant_id = $1 AND vehicle_id = $2", [scope.tenantId, scope.vehicleId]);
  return BigInt(rows[0]?.seq ?? "-1");
};

async function stateRow(scope: Scope) {
  const { rows } = await pool.query<{
    lon: number;
    lat: number;
    srid: number;
    recorded_at: Date;
    movement: string;
    stopped_since: Date | null;
    zone_ids: string[];
    seq: string;
  }>(
    `SELECT ST_X(geom) AS lon, ST_Y(geom) AS lat, ST_SRID(geom) AS srid, recorded_at, movement, stopped_since, zone_ids, seq::text AS seq
       FROM vehicle_state WHERE tenant_id = $1 AND vehicle_id = $2`,
    [scope.tenantId, scope.vehicleId],
  );
  return rows[0];
}

describe("ST_Covers con zonas sembradas", () => {
  it("devuelve las zonas del tenant que contienen cada posición, en orden, también las del borde, y ninguna fuera", async () => {
    const scope = await seedScope("covers");

    const zones = await unitOfWork.run((tx) => tx.zonesCovering(scope.tenantId, [INSIDE, OUTSIDE, ON_EDGE]));

    const expected = [
      { zoneId: scope.criticalZoneId, kind: "critical" },
      { zoneId: scope.depotZoneId, kind: "depot" },
    ].sort((a, b) => a.zoneId.localeCompare(b.zoneId));
    expect(zones[0]).toEqual(expected);
    expect(zones[1]).toEqual([]);
    // ST_Covers (a diferencia de ST_Contains) cuenta el borde del polígono.
    expect(zones[2]).toEqual(expected);
  });

  it("la longitud va primero: las coordenadas intercambiadas no caen en la zona", async () => {
    const scope = await seedScope("swapped");

    const [zones] = await unitOfWork.run((tx) => tx.zonesCovering(scope.tenantId, [{ lon: INSIDE.lat, lat: INSIDE.lon }]));

    expect(zones).toEqual([]);
  });

  it("filtra por tenant: las zonas de otro tenant, aunque ocupen el mismo lugar, no existen", async () => {
    const mine = await seedScope("tenant-a");
    const other = await seedScope("tenant-b");

    const [zones] = await unitOfWork.run((tx) => tx.zonesCovering(mine.tenantId, [INSIDE]));

    const ids = zones?.map((zone) => zone.zoneId) ?? [];
    expect(ids).toContain(mine.criticalZoneId);
    expect(ids).not.toContain(other.criticalZoneId);
    expect(ids).not.toContain(other.depotZoneId);
  });

  it("un tenant sin zonas no recibe ninguna", async () => {
    const [zones] = await unitOfWork.run((tx) => tx.zonesCovering(randomUUID(), [INSIDE]));

    expect(zones).toEqual([]);
  });
});

describe("vehicle_state: UPSERT con seq creciente", () => {
  it("el primer INSERT guarda el punto como (lon, lat) con SRID 4326 y las zonas; el seq sale de la secuencia", async () => {
    const scope = await seedScope("insert");
    const snapshot = snapshotOf(0, { zoneIds: [scope.criticalZoneId, scope.depotZoneId] });

    await unitOfWork.run((tx) => tx.upsertVehicleStates(scope.tenantId, [{ vehicleId: scope.vehicleId, snapshot }]));

    const row = await stateRow(scope);
    expect(row).toMatchObject({ srid: 4326, movement: "moving", stopped_since: null, zone_ids: [scope.criticalZoneId, scope.depotZoneId] });
    expect(row?.lon).toBeCloseTo(INSIDE.lon, 6);
    expect(row?.lat).toBeCloseTo(INSIDE.lat, 6);
    expect(row?.recorded_at.toISOString()).toBe(snapshot.recordedAt);
    expect(BigInt(row?.seq ?? "0")).toBeGreaterThan(0n);
  });

  it("cada actualización toma un seq NUEVO y mayor (el DEFAULT no corre en el DO UPDATE: el SQL lo escribe explícito)", async () => {
    const scope = await seedScope("seq");
    const seqs: bigint[] = [];
    for (const minutes of [0, 1, 2]) {
      await unitOfWork.run((tx) => tx.upsertVehicleStates(scope.tenantId, [{ vehicleId: scope.vehicleId, snapshot: snapshotOf(minutes) }]));
      seqs.push(await seqOf(scope));
    }

    expect(seqs[1]).toBeGreaterThan(seqs[0] ?? 0n);
    expect(seqs[2]).toBeGreaterThan(seqs[1] ?? 0n);
    expect((await stateRow(scope))?.recorded_at.toISOString()).toBe(at(2));
  });

  it("una fila por vehículo: actualizar no crea otra", async () => {
    const scope = await seedScope("single-row");
    for (const minutes of [0, 1]) {
      await unitOfWork.run((tx) => tx.upsertVehicleStates(scope.tenantId, [{ vehicleId: scope.vehicleId, snapshot: snapshotOf(minutes) }]));
    }

    const { rows } = await pool.query<{ n: string }>("SELECT count(*) AS n FROM vehicle_state WHERE tenant_id = $1 AND vehicle_id = $2", [scope.tenantId, scope.vehicleId]);
    expect(rows[0]?.n).toBe("1");
  });

  it("nunca retrocede: un estado con recorded_at anterior o igual no cambia la fila ni su seq", async () => {
    const scope = await seedScope("no-regress");
    await unitOfWork.run((tx) => tx.upsertVehicleStates(scope.tenantId, [{ vehicleId: scope.vehicleId, snapshot: snapshotOf(10, { speedMps: 8 }) }]));
    const before = await stateRow(scope);

    await unitOfWork.run((tx) => tx.upsertVehicleStates(scope.tenantId, [{ vehicleId: scope.vehicleId, snapshot: snapshotOf(5, { speedMps: 99 }) }]));
    await unitOfWork.run((tx) => tx.upsertVehicleStates(scope.tenantId, [{ vehicleId: scope.vehicleId, snapshot: snapshotOf(10, { speedMps: 99 }) }]));

    expect(await stateRow(scope)).toEqual(before);
  });

  it("invariante de la base: stopped_since es null si y solo si el vehículo se mueve (CHECK vehicle_state_stopped_since_check)", async () => {
    const scope = await seedScope("invariant");

    const stoppedWithoutSince = await unitOfWork
      .run((tx) => tx.upsertVehicleStates(scope.tenantId, [{ vehicleId: scope.vehicleId, snapshot: snapshotOf(0, { movement: "stopped", stoppedSince: null }) }]))
      .catch((error: unknown) => error);
    const movingWithSince = await unitOfWork
      .run((tx) => tx.upsertVehicleStates(scope.tenantId, [{ vehicleId: scope.vehicleId, snapshot: snapshotOf(0, { movement: "moving", stoppedSince: at(0) }) }]))
      .catch((error: unknown) => error);

    for (const error of [stoppedWithoutSince, movingWithSince]) {
      expect(error).toMatchObject({ code: "23514", constraint: "vehicle_state_stopped_since_check" });
      // Es un error de la fila: el orquestador lo trata como permanente (DLQ), no como caída de la base.
      expect(classifyFailure(error)).toBe("permanent");
    }
  });

  it("stopped -> moving limpia stopped_since", async () => {
    const scope = await seedScope("stop-move");
    await unitOfWork.run((tx) => tx.upsertVehicleStates(scope.tenantId, [{ vehicleId: scope.vehicleId, snapshot: snapshotOf(0, { movement: "stopped", stoppedSince: at(0), speedMps: 0 }) }]));
    expect((await stateRow(scope))?.stopped_since?.toISOString()).toBe(at(0));

    await unitOfWork.run((tx) => tx.upsertVehicleStates(scope.tenantId, [{ vehicleId: scope.vehicleId, snapshot: snapshotOf(5) }]));

    expect(await stateRow(scope)).toMatchObject({ movement: "moving", stopped_since: null });
  });

  it("clave foránea compuesta: un vehículo no se puede escribir bajo otro tenant (23503)", async () => {
    const mine = await seedScope("fk-a");
    const other = await seedScope("fk-b");

    const error = await unitOfWork
      .run((tx) => tx.upsertVehicleStates(other.tenantId, [{ vehicleId: mine.vehicleId, snapshot: snapshotOf(0) }]))
      .catch((e: unknown) => e);

    expect(error).toMatchObject({ code: "23503" });
    expect(await stateRow(mine)).toBeUndefined();
  });

  it("el estado de un vehículo de otro tenant no se ve ni se bloquea", async () => {
    const mine = await seedScope("lock-a");
    const other = await seedScope("lock-b");
    await unitOfWork.run((tx) => tx.upsertVehicleStates(mine.tenantId, [{ vehicleId: mine.vehicleId, snapshot: snapshotOf(0) }]));

    const seenByOther = await unitOfWork.run((tx) => tx.lockVehicleStates(other.tenantId, [mine.vehicleId]));
    const seenByOwner = await unitOfWork.run((tx) => tx.lockVehicleStates(mine.tenantId, [mine.vehicleId, other.vehicleId]));

    expect(seenByOther.size).toBe(0);
    expect([...seenByOwner.keys()]).toEqual([mine.vehicleId]);
    expect(seenByOwner.get(mine.vehicleId)).toMatchObject({ recordedAt: at(0), movement: "moving", stoppedSince: null, zoneIds: [] });
  });

  it("un tramo con varios vehículos se escribe en una sola sentencia", async () => {
    const first = await seedScope("batch-1");
    const second = await seedScope("batch-2");

    // Dos tenants distintos no caben en una llamada (el tenant es un parámetro): se prueba con dos vehículos del mismo tenant.
    const extraVehicle = randomUUID();
    await pool.query("INSERT INTO vehicles (id, tenant_id, plate) VALUES ($1, $2, $3)", [extraVehicle, first.tenantId, `X${extraVehicle.slice(0, 5).toUpperCase()}`]);
    await unitOfWork.run((tx) =>
      tx.upsertVehicleStates(first.tenantId, [
        { vehicleId: first.vehicleId, snapshot: snapshotOf(0) },
        { vehicleId: extraVehicle, snapshot: snapshotOf(1, { zoneIds: [] }) },
      ]),
    );

    const { rows } = await pool.query<{ n: string }>("SELECT count(*) AS n FROM vehicle_state WHERE tenant_id = $1", [first.tenantId]);
    expect(rows[0]?.n).toBe("2");
    expect(await stateRow(second)).toBeUndefined();
  });

  it("todo o nada: si el trabajo lanza después de escribir, la transacción se revierte", async () => {
    const scope = await seedScope("rollback");

    await expect(
      unitOfWork.run(async (tx) => {
        await tx.upsertVehicleStates(scope.tenantId, [{ vehicleId: scope.vehicleId, snapshot: snapshotOf(0) }]);
        throw new Error("falla después de escribir");
      }),
    ).rejects.toThrow("falla después de escribir");

    expect(await stateRow(scope)).toBeUndefined();
  });
});

describe("alertas: idempotencia y resolución", () => {
  async function alertRow(id: string) {
    const { rows } = await pool.query<{ resolved_at: Date | null; seq: string; zone_id: string | null; raised_at: Date; started_at: Date }>(
      "SELECT resolved_at, seq::text AS seq, zone_id, raised_at, started_at FROM alerts WHERE alert_id = $1",
      [id],
    );
    return rows[0];
  }

  it("insertar la misma alerta dos veces la deja UNA vez (ON CONFLICT DO NOTHING) y solo la primera devuelve su id", async () => {
    const scope = await seedScope("alert-idem");
    const id = alertId();
    const write = { alertId: id, vehicleId: scope.vehicleId, type: "critical_zone_stop" as const, zoneId: scope.criticalZoneId, startedAt: at(0), raisedAt: at(30), resolvedAt: null };

    const first = await unitOfWork.run((tx) => tx.insertAlerts(scope.tenantId, [write]));
    const seqAfterFirst = (await alertRow(id))?.seq;
    const second = await unitOfWork.run((tx) => tx.insertAlerts(scope.tenantId, [{ ...write, raisedAt: at(99) }]));

    expect(first).toEqual([id]);
    expect(second).toEqual([]);
    const { rows } = await pool.query<{ n: string }>("SELECT count(*) AS n FROM alerts WHERE alert_id = $1", [id]);
    expect(rows[0]?.n).toBe("1");
    // La segunda no cambió nada de la primera.
    expect(await alertRow(id)).toMatchObject({ seq: seqAfterFirst });
    expect((await alertRow(id))?.raised_at.toISOString()).toBe(at(30));
  });

  it("la resolución pone resolved_at y un seq nuevo y mayor; resolver otra vez no hace nada", async () => {
    const scope = await seedScope("alert-resolve");
    const id = alertId();
    await unitOfWork.run((tx) =>
      tx.insertAlerts(scope.tenantId, [{ alertId: id, vehicleId: scope.vehicleId, type: "mocked_location", zoneId: null, startedAt: at(0), raisedAt: at(1), resolvedAt: null }]),
    );
    const raisedSeq = BigInt((await alertRow(id))?.seq ?? "0");

    const resolved = await unitOfWork.run((tx) => tx.resolveAlerts(scope.tenantId, [{ alertId: id, resolvedAt: at(10) }]));
    const again = await unitOfWork.run((tx) => tx.resolveAlerts(scope.tenantId, [{ alertId: id, resolvedAt: at(20) }]));

    expect(resolved).toEqual([id]);
    expect(again).toEqual([]);
    const row = await alertRow(id);
    expect(row?.resolved_at?.toISOString()).toBe(at(10));
    expect(BigInt(row?.seq ?? "0")).toBeGreaterThan(raisedSeq);
  });

  it("una alerta levantada y resuelta en el mismo tramo se inserta ya resuelta", async () => {
    const scope = await seedScope("alert-both");
    const id = alertId();

    await unitOfWork.run((tx) =>
      tx.insertAlerts(scope.tenantId, [{ alertId: id, vehicleId: scope.vehicleId, type: "mocked_location", zoneId: null, startedAt: at(0), raisedAt: at(5), resolvedAt: at(3) }]),
    );

    expect((await alertRow(id))?.resolved_at?.toISOString()).toBe(at(3));
    expect(await unitOfWork.run((tx) => tx.lockOpenAlerts(scope.tenantId, [scope.vehicleId]))).toEqual(new Map());
  });

  it("lockOpenAlerts devuelve solo las activas del tenant y del vehículo pedido", async () => {
    const scope = await seedScope("alert-open");
    const other = await seedScope("alert-open-other");
    const [active, resolved, foreign] = [alertId(), alertId(), alertId()];
    await unitOfWork.run(async (tx) => {
      await tx.insertAlerts(scope.tenantId, [
        { alertId: active, vehicleId: scope.vehicleId, type: "critical_zone_stop", zoneId: scope.criticalZoneId, startedAt: at(0), raisedAt: at(20), resolvedAt: null },
        { alertId: resolved, vehicleId: scope.vehicleId, type: "mocked_location", zoneId: null, startedAt: at(1), raisedAt: at(2), resolvedAt: at(3) },
      ]);
      await tx.insertAlerts(other.tenantId, [{ alertId: foreign, vehicleId: other.vehicleId, type: "mocked_location", zoneId: null, startedAt: at(0), raisedAt: at(1), resolvedAt: null }]);
    });

    const open = await unitOfWork.run((tx) => tx.lockOpenAlerts(scope.tenantId, [scope.vehicleId, other.vehicleId]));

    expect(open).toEqual(new Map([[scope.vehicleId, [{ alertId: active, type: "critical_zone_stop", zoneId: scope.criticalZoneId, startedAt: at(0) }]]]));
  });

  it("no se puede resolver la alerta de otro tenant", async () => {
    const mine = await seedScope("alert-x-a");
    const other = await seedScope("alert-x-b");
    const id = alertId();
    await unitOfWork.run((tx) =>
      tx.insertAlerts(mine.tenantId, [{ alertId: id, vehicleId: mine.vehicleId, type: "mocked_location", zoneId: null, startedAt: at(0), raisedAt: at(1), resolvedAt: null }]),
    );

    const resolved = await unitOfWork.run((tx) => tx.resolveAlerts(other.tenantId, [{ alertId: id, resolvedAt: at(5) }]));

    expect(resolved).toEqual([]);
    expect((await alertRow(id))?.resolved_at).toBeNull();
  });

  it("clave foránea compuesta: una alerta no puede apuntar a una zona de otro tenant (23503)", async () => {
    const mine = await seedScope("alert-fk-a");
    const other = await seedScope("alert-fk-b");

    const error = await unitOfWork
      .run((tx) =>
        tx.insertAlerts(mine.tenantId, [{ alertId: alertId(), vehicleId: mine.vehicleId, type: "critical_zone_stop", zoneId: other.criticalZoneId, startedAt: at(0), raisedAt: at(20), resolvedAt: null }]),
      )
      .catch((e: unknown) => e);

    expect(error).toMatchObject({ code: "23503" });
  });
});

describe("readPublishable", () => {
  it("devuelve el estado vigente con la placa, seq como string y las zonas, y solo del tenant pedido", async () => {
    const scope = await seedScope("publish");
    const other = await seedScope("publish-other");
    await unitOfWork.run(async (tx) => {
      await tx.upsertVehicleStates(scope.tenantId, [{ vehicleId: scope.vehicleId, snapshot: snapshotOf(0, { movement: "stopped", stoppedSince: at(0), speedMps: 0, zoneIds: [scope.criticalZoneId] }) }]);
      await tx.upsertVehicleStates(other.tenantId, [{ vehicleId: other.vehicleId, snapshot: snapshotOf(0) }]);
    });

    const publishable = await unitOfWork.run((tx) => tx.readPublishable(scope.tenantId, { vehicleIds: [scope.vehicleId, other.vehicleId], alertsSince: at(0) }));

    expect(publishable.states).toHaveLength(1);
    const [state] = publishable.states;
    expect(state).toMatchObject({
      vehicleId: scope.vehicleId,
      plate: `P${scope.vehicleId.slice(0, 5).toUpperCase()}`,
      movement: "stopped",
      stoppedSince: at(0),
      recordedAt: at(0),
      receivedAt: at(1),
      zoneIds: [scope.criticalZoneId],
    });
    expect(typeof state?.seq).toBe("string");
    expect(state?.seq).toBe((await seqOf(scope)).toString());
    expect(state?.lon).toBeCloseTo(INSIDE.lon, 6);
  });

  it("las alertas incluyen el nombre de la zona y la placa; excluye las resueltas antes de alertsSince y las de otros tenants", async () => {
    const scope = await seedScope("publish-alerts");
    const other = await seedScope("publish-alerts-other");
    const [active, recent, old, foreign] = [alertId(), alertId(), alertId(), alertId()];
    await unitOfWork.run(async (tx) => {
      await tx.insertAlerts(scope.tenantId, [
        { alertId: active, vehicleId: scope.vehicleId, type: "critical_zone_stop", zoneId: scope.criticalZoneId, startedAt: at(0), raisedAt: at(20), resolvedAt: null },
        { alertId: recent, vehicleId: scope.vehicleId, type: "mocked_location", zoneId: null, startedAt: at(10), raisedAt: at(11), resolvedAt: at(30) },
        { alertId: old, vehicleId: scope.vehicleId, type: "mocked_location", zoneId: null, startedAt: at(-60), raisedAt: at(-59), resolvedAt: at(-40) },
      ]);
      await tx.insertAlerts(other.tenantId, [{ alertId: foreign, vehicleId: other.vehicleId, type: "mocked_location", zoneId: null, startedAt: at(0), raisedAt: at(1), resolvedAt: null }]);
    });

    const { alerts } = await unitOfWork.run((tx) => tx.readPublishable(scope.tenantId, { vehicleIds: [scope.vehicleId, other.vehicleId], alertsSince: at(5) }));

    expect(alerts.map((alert) => alert.alertId).sort()).toEqual([active, recent].sort());
    const activeAlert = alerts.find((alert) => alert.alertId === active);
    expect(activeAlert).toMatchObject({ zoneName: "Zona crítica publish-alerts", zoneId: scope.criticalZoneId, resolvedAt: null, startedAt: at(0), raisedAt: at(20) });
    expect(activeAlert?.plate).toBe(`P${scope.vehicleId.slice(0, 5).toUpperCase()}`);
    expect(alerts.find((alert) => alert.alertId === recent)).toMatchObject({ zoneId: null, zoneName: null, resolvedAt: at(30) });
    // Ordenadas por seq.
    const seqs = alerts.map((alert) => BigInt(alert.seq));
    expect(seqs).toEqual([...seqs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });
});

describe("bloqueo FOR UPDATE", () => {
  it("mientras una transacción tiene el estado de un vehículo, otra que lo pide espera a que termine", async () => {
    const scope = await seedScope("lock");
    await unitOfWork.run((tx) => tx.upsertVehicleStates(scope.tenantId, [{ vehicleId: scope.vehicleId, snapshot: snapshotOf(0) }]));

    let releaseFirst: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstHoldsLock: () => void = () => undefined;
    const locked = new Promise<void>((resolve) => {
      firstHoldsLock = resolve;
    });
    const first = unitOfWork.run(async (tx) => {
      await tx.lockVehicleStates(scope.tenantId, [scope.vehicleId]);
      firstHoldsLock();
      await gate;
    });
    await locked;
    let secondDone = false;
    const second = unitOfWork.run(async (tx) => {
      await tx.lockVehicleStates(scope.tenantId, [scope.vehicleId]);
      secondDone = true;
    });

    // Espera por sondeo a que la segunda esté de verdad bloqueada en un lock (no un sleep fijo).
    const deadline = Date.now() + 15_000;
    for (;;) {
      const { rows } = await pool.query<{ n: string }>("SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'");
      if (Number(rows[0]?.n) > 0) break;
      if (Date.now() > deadline) throw new Error("La segunda transacción no quedó esperando el bloqueo.");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(secondDone).toBe(false);

    releaseFirst();
    await Promise.all([first, second]);
    expect(secondDone).toBe(true);
  });
});

describe("el caso de uso sobre la base real", () => {
  interface Published {
    events: FleetEvents[];
  }

  function useCaseFor(scope: Scope, published: Published, rules = DEFAULT_FLEET_RULES) {
    return createUpdateFleetState({
      unitOfWork,
      publisher: {
        publish: (events) => {
          published.events.push(events);
          return Promise.resolve();
        },
      },
      alertIds: createAlertIdGenerator(),
      clock: { now: () => new Date(BASE_MS + 3 * 3_600_000) },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      rules,
    });
  }

  const deviceId = randomUUID();
  const pointOf = (scope: Scope, minutes: number, overrides: Partial<TelemetryRawEvent["point"]> = {}): { event: TelemetryRawEvent; correlationId: string } => ({
    correlationId: `it-${minutes}`,
    event: {
      schemaVersion: 1,
      tenantId: scope.tenantId,
      deviceId,
      receivedAt: at(minutes + 1),
      point: {
        eventId: randomUUID(),
        vehicleId: scope.vehicleId,
        recordedAt: at(minutes),
        lon: INSIDE.lon,
        lat: INSIDE.lat,
        speedMps: 0,
        headingDeg: null,
        accuracyM: 5,
        mocked: false,
        lowAccuracy: false,
        ...overrides,
      },
    },
  });

  it("detenerse 25 minutos en una zona crítica levanta UNA alerta, con el estado stopped y stoppedSince = el primer fix detenido; moverse la resuelve", async () => {
    const scope = await seedScope("usecase");
    const useCase = useCaseFor(scope, { events: [] });
    const stop = [0, 5, 10, 15, 20, 25].map((minutes) => pointOf(scope, minutes));

    const first = await useCase.apply([pointOf(scope, -5, { speedMps: 9 }), ...stop]);

    expect(first.vehicleStates).toHaveLength(1);
    expect(first.vehicleStates[0]?.event.state).toMatchObject({
      movement: "stopped",
      stoppedSince: at(0),
      recordedAt: at(25),
      zoneIds: [scope.criticalZoneId, scope.depotZoneId].sort(),
    });
    expect(first.alerts).toHaveLength(1);
    expect(first.alerts[0]?.event.alert).toMatchObject({
      type: "critical_zone_stop",
      zoneId: scope.criticalZoneId,
      zoneName: "Zona crítica usecase",
      startedAt: at(0),
      resolvedAt: null,
    });
    const firstSeq = BigInt(first.vehicleStates[0]?.event.state.seq ?? "0");
    const alertSeq = BigInt(first.alerts[0]?.event.alert.seq ?? "0");

    // Reentrega del mismo tramo: no cambia nada en la base, y republica el MISMO estado y la MISMA alerta (mismo seq).
    const again = await useCase.apply([pointOf(scope, -5, { speedMps: 9 }), ...stop]);
    expect(again.vehicleStates[0]?.event.state.seq).toBe(first.vehicleStates[0]?.event.state.seq);
    expect(again.alerts.map((entry) => entry.event.alert)).toEqual(first.alerts.map((entry) => entry.event.alert));
    const { rows: alertCount } = await pool.query<{ n: string }>("SELECT count(*) AS n FROM alerts WHERE tenant_id = $1 AND vehicle_id = $2", [scope.tenantId, scope.vehicleId]);
    expect(alertCount[0]?.n).toBe("1");

    // Moverse resuelve la alerta (resolvedAt = el fix en movimiento) y el estado vuelve a moving con stoppedSince null.
    const moved = await useCase.apply([pointOf(scope, 30, { speedMps: 10 })]);
    expect(moved.vehicleStates[0]?.event.state).toMatchObject({ movement: "moving", stoppedSince: null, recordedAt: at(30) });
    expect(BigInt(moved.vehicleStates[0]?.event.state.seq ?? "0")).toBeGreaterThan(firstSeq);
    expect(moved.alerts).toHaveLength(1);
    expect(moved.alerts[0]?.event.alert).toMatchObject({ alertId: first.alerts[0]?.event.alert.alertId, resolvedAt: at(30) });
    expect(BigInt(moved.alerts[0]?.event.alert.seq ?? "0")).toBeGreaterThan(alertSeq);
  });

  it("un punto tardío se persiste pero no mueve el estado ni su seq", async () => {
    const scope = await seedScope("usecase-late");
    const useCase = useCaseFor(scope, { events: [] });
    await useCase.apply([pointOf(scope, 10, { speedMps: 9 })]);
    const seqBefore = await seqOf(scope);

    const update = await useCase.apply([pointOf(scope, 5, { speedMps: 0 })]);

    expect(await seqOf(scope)).toBe(seqBefore);
    expect(update.stats.statesWritten).toBe(0);
    expect(update.vehicleStates[0]?.event.state).toMatchObject({ recordedAt: at(10), movement: "moving" });
  });

  it("dos tenants en el mismo tramo: cada uno ve solo lo suyo y cada zona se evalúa con las zonas de SU tenant", async () => {
    const a = await seedScope("usecase-a");
    const b = await seedScope("usecase-b");
    const useCase = useCaseFor(a, { events: [] });

    const update = await useCase.apply([pointOf(a, 0), pointOf(b, 0, { lon: OUTSIDE.lon, lat: OUTSIDE.lat })]);

    const byVehicle = new Map(update.vehicleStates.map((entry) => [entry.key, entry.event]));
    expect(byVehicle.get(a.vehicleId)).toMatchObject({ tenantId: a.tenantId, state: { zoneIds: [a.criticalZoneId, a.depotZoneId].sort() } });
    expect(byVehicle.get(b.vehicleId)).toMatchObject({ tenantId: b.tenantId, state: { zoneIds: [] } });
  });
});
