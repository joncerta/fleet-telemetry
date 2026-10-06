import { describe, expect, it } from "vitest";
import type { VehicleSnapshot } from "../domain/vehicle-state.js";
import { createPgFleetStateUnitOfWork, type FleetStateClient, type FleetStatePool } from "./pg-fleet-state-store.js";

const TENANT = "9d7e1b34-2a6c-4f08-b5d3-6e4a8c1f0b92";
const VEHICLE = "a1c4e9d2-7b3f-4c58-8e16-0d9f2b6a4c71";

interface Query {
  sql: string;
  params: unknown[];
}

/** Un pool con una conexión que registra lo que recibe. `fail` decide qué sentencias fallan. */
function fakePool(options: { fail?: (sql: string) => Error | undefined; rows?: (sql: string) => Record<string, unknown>[] } = {}) {
  const queries: Query[] = [];
  const releases: (boolean | Error | undefined)[] = [];
  let connections = 0;
  const client: FleetStateClient = {
    query: (sql, params) => {
      queries.push({ sql, params });
      const failure = options.fail?.(sql);
      if (failure !== undefined) return Promise.reject(failure);
      const rows = options.rows?.(sql) ?? [];
      return Promise.resolve({ rows, rowCount: rows.length });
    },
    release: (destroy) => {
      releases.push(destroy);
    },
  };
  const pool: FleetStatePool = {
    connect: () => {
      connections += 1;
      return Promise.resolve(client);
    },
  };
  return { pool, queries, releases, connections: () => connections };
}

const SNAPSHOT: VehicleSnapshot = {
  recordedAt: "2026-03-14T10:00:00.000Z",
  receivedAt: "2026-03-14T10:00:02.000Z",
  lon: -75.5636,
  lat: 6.2518,
  speedMps: 0,
  headingDeg: null,
  movement: "stopped",
  stoppedSince: "2026-03-14T09:40:00.000Z",
  zoneIds: ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"],
  mocked: false,
  lowAccuracy: false,
};

describe("createPgFleetStateUnitOfWork", () => {
  it("abre UNA transacción en UNA conexión: BEGIN, el trabajo, COMMIT, y libera la conexión", async () => {
    const { pool, queries, releases, connections } = fakePool();

    const result = await createPgFleetStateUnitOfWork(pool).run(async (tx) => {
      await tx.lockVehicleStates(TENANT, [VEHICLE]);
      await tx.lockOpenAlerts(TENANT, [VEHICLE]);
      return "listo";
    });

    expect(result).toBe("listo");
    expect(connections()).toBe(1);
    expect(queries.map((query) => query.sql.trim().split(/\s+/)[0])).toEqual(["BEGIN", "SELECT", "SELECT", "COMMIT"]);
    expect(releases).toEqual([undefined]);
  });

  it("si el trabajo lanza: ROLLBACK (sin COMMIT), el MISMO error sube y la conexión se libera", async () => {
    const { pool, queries, releases } = fakePool();
    const failure = new Error("falló el trabajo");

    await expect(
      createPgFleetStateUnitOfWork(pool).run(() => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(queries.map((query) => query.sql)).toEqual(["BEGIN", "ROLLBACK"]);
    expect(releases).toEqual([undefined]);
  });

  it("si una sentencia falla, el error de `pg` sube tal cual (el orquestador lo clasifica) y se revierte", async () => {
    const pgError = Object.assign(new Error("insert or update on table violates foreign key constraint"), { code: "23503" });
    const { pool, queries } = fakePool({ fail: (sql) => (sql.includes("INSERT INTO vehicle_state") ? pgError : undefined) });

    await expect(createPgFleetStateUnitOfWork(pool).run((tx) => tx.upsertVehicleStates(TENANT, [{ vehicleId: VEHICLE, snapshot: SNAPSHOT }]))).rejects.toBe(pgError);

    expect(queries.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("si el COMMIT falla, intenta el ROLLBACK, libera la conexión y propaga el error del COMMIT", async () => {
    const commitFailure = new Error("conexión cortada en el commit");
    const { pool, queries, releases } = fakePool({ fail: (sql) => (sql === "COMMIT" ? commitFailure : undefined) });

    await expect(createPgFleetStateUnitOfWork(pool).run(() => Promise.resolve())).rejects.toBe(commitFailure);

    expect(queries.map((query) => query.sql)).toEqual(["BEGIN", "COMMIT", "ROLLBACK"]);
    expect(releases).toEqual([undefined]);
  });

  it("si el ROLLBACK también falla, la conexión se DESTRUYE (no vuelve al pool) y sube el error original", async () => {
    const original = new Error("falló el trabajo");
    const { pool, releases } = fakePool({ fail: (sql) => (sql === "ROLLBACK" ? new Error("conexión muerta") : undefined) });

    await expect(
      createPgFleetStateUnitOfWork(pool).run(() => {
        throw original;
      }),
    ).rejects.toBe(original);

    expect(releases).toEqual([true]);
  });

  it("si no se consigue conexión, el error sube y no hay nada que liberar", async () => {
    const failure = new Error("pool agotado");
    const pool: FleetStatePool = { connect: () => Promise.reject(failure) };

    await expect(createPgFleetStateUnitOfWork(pool).run(() => Promise.resolve())).rejects.toBe(failure);
  });
});

describe("sentencias del read model", () => {
  /** Ejecuta una operación y devuelve la ÚNICA sentencia que mandó (sin BEGIN/COMMIT). */
  async function sqlOf(operation: (tx: Parameters<Parameters<ReturnType<typeof createPgFleetStateUnitOfWork>["run"]>[0]>[0]) => Promise<unknown>, rows?: Record<string, unknown>[]) {
    const { pool, queries } = fakePool({ rows: (sql) => (/^(BEGIN|COMMIT)$/.test(sql) ? [] : (rows ?? [])) });
    await createPgFleetStateUnitOfWork(pool).run(operation);
    return queries.filter((query) => !/^(BEGIN|COMMIT)$/.test(query.sql));
  }

  it("cada operación manda el tenant del evento como $1 y ningún valor viaja dentro del texto del SQL", async () => {
    const [states] = await sqlOf((tx) => tx.lockVehicleStates(TENANT, [VEHICLE]));
    const [alerts] = await sqlOf((tx) => tx.lockOpenAlerts(TENANT, [VEHICLE]));
    const [zones] = await sqlOf((tx) => tx.zonesCovering(TENANT, [{ lon: -75.5, lat: 6.2 }]));
    const [upsert] = await sqlOf((tx) => tx.upsertVehicleStates(TENANT, [{ vehicleId: VEHICLE, snapshot: SNAPSHOT }]));
    const [insert] = await sqlOf((tx) =>
      tx.insertAlerts(TENANT, [
        { alertId: "4cf55448-3962-55da-8603-eccff932a311", vehicleId: VEHICLE, type: "mocked_location", zoneId: null, startedAt: SNAPSHOT.recordedAt, raisedAt: SNAPSHOT.receivedAt, resolvedAt: null },
      ]),
    );
    const [resolve] = await sqlOf((tx) => tx.resolveAlerts(TENANT, [{ alertId: "4cf55448-3962-55da-8603-eccff932a311", resolvedAt: SNAPSHOT.recordedAt }]));
    const published = await sqlOf((tx) => tx.readPublishable(TENANT, { vehicleIds: [VEHICLE], alertsSince: SNAPSHOT.recordedAt }));

    const all = [states, alerts, zones, upsert, insert, resolve, ...published];
    for (const query of all) {
      expect(query?.params[0]).toBe(TENANT);
      expect(query?.sql).toMatch(/tenant_id = \$1|\$1::uuid/);
      // Nada de los valores (ids, coordenadas, fechas) entra en el texto del SQL.
      expect(query?.sql).not.toMatch(new RegExp(`${TENANT}|${VEHICLE}|75\\.5|2026-03-14`));
    }
    expect(published).toHaveLength(2);
  });

  it("el UPSERT escribe seq = nextval('fleet_event_seq') explícito en el DO UPDATE (el DEFAULT solo corre en el INSERT) y nunca retrocede recorded_at", async () => {
    const [upsert] = await sqlOf((tx) => tx.upsertVehicleStates(TENANT, [{ vehicleId: VEHICLE, snapshot: SNAPSHOT }]));

    expect(upsert?.sql).toMatch(/DO UPDATE SET[\s\S]*seq = nextval\('fleet_event_seq'\)/);
    expect(upsert?.sql).toMatch(/WHERE vehicle_state\.tenant_id = EXCLUDED\.tenant_id AND vehicle_state\.recorded_at < EXCLUDED\.recorded_at/);
    expect(upsert?.sql).toContain("ST_SetSRID(ST_MakePoint(s.lon, s.lat), 4326)");
  });

  it("la resolución escribe un seq nuevo explícito y solo toca alertas activas del tenant", async () => {
    const [resolve] = await sqlOf((tx) => tx.resolveAlerts(TENANT, [{ alertId: "4cf55448-3962-55da-8603-eccff932a311", resolvedAt: SNAPSHOT.recordedAt }]));

    expect(resolve?.sql).toContain("seq = nextval('fleet_event_seq')");
    expect(resolve?.sql).toMatch(/a\.tenant_id = \$1 AND a\.resolved_at IS NULL/);
  });

  it("el alta de alertas es idempotente por alert_id", async () => {
    const [insert] = await sqlOf((tx) =>
      tx.insertAlerts(TENANT, [
        { alertId: "4cf55448-3962-55da-8603-eccff932a311", vehicleId: VEHICLE, type: "mocked_location", zoneId: null, startedAt: SNAPSHOT.recordedAt, raisedAt: SNAPSHOT.receivedAt, resolvedAt: null },
      ]),
    );

    expect(insert?.sql).toContain("ON CONFLICT (alert_id) DO NOTHING");
  });

  it("las zonas se piden con ST_Covers, longitud primero, y los arreglos van como parámetros paralelos", async () => {
    const [zones] = await sqlOf((tx) =>
      tx.zonesCovering(TENANT, [
        { lon: -75.5, lat: 6.2 },
        { lon: -74.1, lat: 4.7 },
      ]),
    );

    expect(zones?.sql).toContain("ST_Covers(z.geom, ST_SetSRID(ST_MakePoint(p.lon, p.lat), 4326))");
    expect(zones?.params).toEqual([TENANT, [-75.5, -74.1], [6.2, 4.7]]);
  });

  it("las zonas de cada posición se devuelven en el orden de las posiciones (también las que no tienen zona)", async () => {
    const zoneId = "11111111-1111-4111-8111-111111111111";
    const { pool } = fakePool({ rows: (sql) => (sql.includes("ST_Covers") ? [{ idx: 2, zone_id: zoneId, kind: "critical" }] : []) });

    const zones = await createPgFleetStateUnitOfWork(pool).run((tx) =>
      tx.zonesCovering(TENANT, [
        { lon: 1, lat: 1 },
        { lon: 2, lat: 2 },
        { lon: 3, lat: 3 },
      ]),
    );

    expect(zones).toEqual([[], [{ zoneId, kind: "critical" }], []]);
  });

  it("sin posiciones, estados, alertas o resoluciones no se manda ninguna sentencia", async () => {
    const queries = await sqlOf(async (tx) => {
      await tx.zonesCovering(TENANT, []);
      await tx.upsertVehicleStates(TENANT, []);
      await tx.insertAlerts(TENANT, []);
      await tx.resolveAlerts(TENANT, []);
    });

    expect(queries).toEqual([]);
  });

  it("zone_ids viaja como texto separado por comas y un estado sin zonas, como cadena vacía", async () => {
    const [upsert] = await sqlOf((tx) =>
      tx.upsertVehicleStates(TENANT, [
        { vehicleId: VEHICLE, snapshot: SNAPSHOT },
        { vehicleId: "b2d5f0e3-8c4a-4d69-9f27-1e0a3c7b5d82", snapshot: { ...SNAPSHOT, zoneIds: [] } },
      ]),
    );

    expect(upsert?.params[10]).toEqual(["11111111-1111-4111-8111-111111111111,22222222-2222-4222-8222-222222222222", ""]);
  });
});
