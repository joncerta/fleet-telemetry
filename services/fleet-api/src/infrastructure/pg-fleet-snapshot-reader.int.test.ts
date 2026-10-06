import { randomUUID } from "node:crypto";
import { alertSchema, vehicleStateSchema } from "@fleet/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIntegrationDatabase, createSeeder, type IntegrationDatabase, type Seeder } from "../testing/integration-db.js";
import { createPgFleetSnapshotReader, MAX_SNAPSHOT_VEHICLES, SnapshotTooLargeError, type SnapshotClient, type SnapshotPool } from "./pg-fleet-snapshot-reader.js";

// Contra TimescaleDB/PostGIS real, con las migraciones reales y el rol de los servicios (fleet_app): el snapshot del SSE se lee en UNA
// transacción REPEATABLE READ y debe funcionar con sus permisos.
let db: IntegrationDatabase;
let seed: Seeder;

beforeAll(async () => {
  db = await createIntegrationDatabase("fleet-api-snapshot-reader-it");
  seed = createSeeder(db.pool);
});

afterAll(async () => {
  await db?.close();
});

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

describe("createPgFleetSnapshotReader", () => {
  it("devuelve los vehículos del tenant con placa, posición (longitud primero), zonas y seq como texto, validados con el contrato", async () => {
    const tenant = await seed.tenant();
    const zone = await seed.zone(tenant);
    const moving = await seed.vehicle(tenant, "MOV001");
    const stopped = await seed.vehicle(tenant, "STP001");
    await seed.state(tenant, moving, { movement: "moving", lon: -74.0721, lat: 4.711 });
    const stoppedSince = minutesAgo(40);
    await seed.state(tenant, stopped, { movement: "stopped", stoppedSince, zoneIds: [zone], lon: -74.07, lat: 4.71 });

    const snapshot = await createPgFleetSnapshotReader(db.pool).read(tenant);

    expect(snapshot.vehicles).toHaveLength(2);
    for (const vehicle of snapshot.vehicles) expect(vehicleStateSchema.parse(vehicle)).toEqual(vehicle);
    const byId = new Map(snapshot.vehicles.map((vehicle) => [vehicle.vehicleId, vehicle]));
    expect(byId.get(moving)).toMatchObject({ plate: "MOV001", movement: "moving", stoppedSince: null, zoneIds: [], mocked: false });
    expect(byId.get(moving)?.lon).toBeCloseTo(-74.0721, 6);
    expect(byId.get(moving)?.lat).toBeCloseTo(4.711, 6);
    expect(byId.get(stopped)).toMatchObject({ plate: "STP001", movement: "stopped", zoneIds: [zone] });
    expect(byId.get(stopped)?.stoppedSince).toBe(stoppedSince.toISOString());
    // seq es bigint: llega como texto, un entero sin signo, y distinto por vehículo.
    expect(new Set(snapshot.vehicles.map((vehicle) => vehicle.seq)).size).toBe(2);
    for (const vehicle of snapshot.vehicles) expect(vehicle.seq).toMatch(/^[1-9][0-9]*$/);
  });

  it("devuelve solo las alertas ACTIVAS, con la placa del vehículo y el nombre de la zona", async () => {
    const tenant = await seed.tenant();
    const zone = await seed.zone(tenant, { name: "Zona crítica norte" });
    const vehicle = await seed.vehicle(tenant, "ALR001");
    const active = await seed.alert(tenant, vehicle, { zoneId: zone, raisedAt: minutesAgo(20).toISOString() });
    await seed.alert(tenant, vehicle, { zoneId: zone, resolvedAt: minutesAgo(5), raisedAt: minutesAgo(60).toISOString() });

    const snapshot = await createPgFleetSnapshotReader(db.pool).read(tenant);

    expect(snapshot.alerts).toHaveLength(1);
    const [alert] = snapshot.alerts;
    expect(alertSchema.parse(alert)).toEqual(alert);
    expect(alert).toMatchObject({ alertId: active, vehicleId: vehicle, plate: "ALR001", zoneId: zone, zoneName: "Zona crítica norte", resolvedAt: null, type: "critical_zone_stop" });
    expect(alert?.seq).toMatch(/^[1-9][0-9]*$/);
  });

  it("un tenant sin datos recibe listas vacías", async () => {
    const tenant = await seed.tenant();

    await expect(createPgFleetSnapshotReader(db.pool).read(tenant)).resolves.toEqual({ vehicles: [], alerts: [] });
  });

  it("no mezcla los datos de otro tenant", async () => {
    const [a, b] = [await seed.tenant(), await seed.tenant()];
    const vehicleA = await seed.vehicle(a, "AAA111");
    const vehicleB = await seed.vehicle(b, "BBB222");
    await seed.state(a, vehicleA);
    await seed.state(b, vehicleB);
    await seed.alert(a, vehicleA);
    await seed.alert(b, vehicleB);
    const reader = createPgFleetSnapshotReader(db.pool);

    const snapshotA = await reader.read(a);
    const snapshotB = await reader.read(b);

    expect(snapshotA.vehicles.map((vehicle) => vehicle.plate)).toEqual(["AAA111"]);
    expect(snapshotA.alerts.map((alert) => alert.plate)).toEqual(["AAA111"]);
    expect(snapshotB.vehicles.map((vehicle) => vehicle.plate)).toEqual(["BBB222"]);
    expect(snapshotB.alerts.map((alert) => alert.plate)).toEqual(["BBB222"]);
  });

  it("lee ambas tablas en UNA transacción REPEATABLE READ: lo que otra conexión confirma entre las dos consultas no entra al snapshot", async () => {
    const tenant = await seed.tenant();
    const vehicle = await seed.vehicle(tenant);
    await seed.state(tenant, vehicle);
    const lateVehicle = await seed.vehicle(tenant);
    let injected = false;
    // Entre la consulta de vehículos y la de alertas, otra conexión confirma una alerta nueva (con seq mayor): el cursor del snapshot no puede
    // describir una alerta que el snapshot no trae, ni al revés.
    const racing: SnapshotPool = {
      connect: async () => {
        const client = await db.pool.connect();
        const wrapped: SnapshotClient = {
          query: async (sql, params) => {
            const result = await client.query(sql, params);
            if (!injected && /FROM vehicle_state/.test(sql)) {
              injected = true;
              await seed.alert(tenant, lateVehicle);
            }
            return result;
          },
          release: (discard) => client.release(discard),
        };
        return wrapped;
      },
    };

    const snapshot = await createPgFleetSnapshotReader(racing).read(tenant);

    expect(injected).toBe(true);
    expect(snapshot.alerts).toEqual([]);
    // Y una lectura nueva sí la ve.
    expect((await createPgFleetSnapshotReader(db.pool).read(tenant)).alerts).toHaveLength(1);
  });

  it("si una consulta falla, el error se propaga, se hace ROLLBACK y la conexión vuelve al pool utilizable", async () => {
    const tenant = await seed.tenant();
    const statements: string[] = [];
    let released = 0;
    const failing: SnapshotPool = {
      connect: async () => {
        const client = await db.pool.connect();
        return {
          query: (sql, params) => {
            statements.push(sql.trim().split(/\s/, 1)[0] ?? "");
            return /FROM alerts/.test(sql) ? Promise.reject(new Error("fallo simulado")) : client.query(sql, params);
          },
          release: (discard) => {
            released += 1;
            client.release(discard);
          },
        };
      },
    };

    await expect(createPgFleetSnapshotReader(failing).read(tenant)).rejects.toThrow("fallo simulado");

    expect(released).toBe(1);
    expect(statements).toContain("ROLLBACK");
    // La conexión devuelta no quedó dentro de una transacción abortada.
    await expect(createPgFleetSnapshotReader(db.pool).read(tenant)).resolves.toEqual({ vehicles: [], alerts: [] });
  });

  it("un tenant con más vehículos que el tope falla de forma explícita (no se trunca) y no deja la conexión ocupada", async () => {
    const tenant = await seed.tenant();
    await db.pool.query(
      `WITH v AS (
         INSERT INTO vehicles (id, tenant_id, plate) SELECT gen_random_uuid(), $1, 'B' || g FROM generate_series(1, $2::int) AS g RETURNING id
       )
       INSERT INTO vehicle_state (vehicle_id, tenant_id, geom, recorded_at, received_at, movement, mocked, low_accuracy)
       SELECT id, $1, ST_SetSRID(ST_MakePoint(-74.07, 4.71), 4326), now(), now(), 'moving', false, false FROM v`,
      [tenant, MAX_SNAPSHOT_VEHICLES + 1],
    );

    await expect(createPgFleetSnapshotReader(db.pool).read(tenant)).rejects.toBeInstanceOf(SnapshotTooLargeError);

    await expect(createPgFleetSnapshotReader(db.pool).read(randomUUID())).resolves.toEqual({ vehicles: [], alerts: [] });
  });
});
