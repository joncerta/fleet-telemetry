import { randomUUID } from "node:crypto";
import { alertSchema, zoneFeatureCollectionSchema } from "@fleet/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { noSignalCutoff, stoppedSinceCutoff } from "../domain/fleet-status.js";
import { BOGOTA_OVERLAP, OVERLAP_POINT, createIntegrationDatabase, createSeeder, type IntegrationDatabase, type Seeder } from "../testing/integration-db.js";
import { createPgFleetReadRepository, MAX_ZONES } from "./pg-fleet-read-repository.js";

// Contra TimescaleDB/PostGIS real, sobre una base temporal con las migraciones reales y con el rol de los servicios (fleet_app): las consultas
// del read model deben funcionar con sus permisos y sus índices. Los datos de cada test llevan UUID propios y un tenant propio.
let db: IntegrationDatabase;
let seed: Seeder;
let repository: ReturnType<typeof createPgFleetReadRepository>;

beforeAll(async () => {
  db = await createIntegrationDatabase("fleet-api-read-repository-it");
  seed = createSeeder(db.pool);
  repository = createPgFleetReadRepository(db.pool);
});

afterAll(async () => {
  await db?.close();
});

const NOW = new Date("2026-10-06T12:00:00.000Z");
const minutesBefore = (minutes: number, from = NOW) => new Date(from.getTime() - minutes * 60_000);

describe("countVehicleStatus", () => {
  it("particiona los vehículos del tenant: con señal por movimiento, y sin señal (viejo o nunca reportó)", async () => {
    const tenant = await seed.tenant();
    const [moving, stopped, stale] = [await seed.vehicle(tenant), await seed.vehicle(tenant), await seed.vehicle(tenant)];
    await seed.vehicle(tenant); // nunca reportó: sin fila de estado
    await seed.state(tenant, moving, { movement: "moving", receivedAt: minutesBefore(1) });
    await seed.state(tenant, stopped, { movement: "stopped", receivedAt: minutesBefore(2) });
    await seed.state(tenant, stale, { movement: "moving", receivedAt: minutesBefore(30) });

    const counts = await repository.countVehicleStatus(tenant, noSignalCutoff(NOW));

    expect(counts).toEqual({ moving: 1, stopped: 1, noSignal: 2 });
    expect(counts.moving + counts.stopped + counts.noSignal).toBe(4);
  });

  it("un vehículo sin señal cuenta solo en noSignal, aunque su último estado fuera detenido", async () => {
    const tenant = await seed.tenant();
    await seed.state(tenant, await seed.vehicle(tenant), { movement: "stopped", receivedAt: minutesBefore(60) });

    await expect(repository.countVehicleStatus(tenant, noSignalCutoff(NOW))).resolves.toEqual({ moving: 0, stopped: 0, noSignal: 1 });
  });

  it("el borde es el de hasNoSignal: recibido justo en el corte tiene señal; un milisegundo antes, no", async () => {
    const tenant = await seed.tenant();
    const cutoff = noSignalCutoff(NOW);
    await seed.state(tenant, await seed.vehicle(tenant), { receivedAt: cutoff });
    await seed.state(tenant, await seed.vehicle(tenant), { receivedAt: new Date(cutoff.getTime() - 1) });

    await expect(repository.countVehicleStatus(tenant, cutoff)).resolves.toEqual({ moving: 1, stopped: 0, noSignal: 1 });
  });

  it("no cuenta los vehículos de otro tenant", async () => {
    const [a, b] = [await seed.tenant(), await seed.tenant()];
    await seed.state(a, await seed.vehicle(a), { receivedAt: minutesBefore(1) });
    await seed.vehicle(b);
    await seed.state(b, await seed.vehicle(b), { movement: "stopped", receivedAt: minutesBefore(1) });

    await expect(repository.countVehicleStatus(a, noSignalCutoff(NOW))).resolves.toEqual({ moving: 1, stopped: 0, noSignal: 0 });
  });

  it("un tenant sin vehículos da ceros", async () => {
    await expect(repository.countVehicleStatus(await seed.tenant(), noSignalCutoff(NOW))).resolves.toEqual({ moving: 0, stopped: 0, noSignal: 0 });
  });
});

describe("countActiveAlerts", () => {
  it("cuenta solo las alertas sin resolver del tenant", async () => {
    const [a, b] = [await seed.tenant(), await seed.tenant()];
    const [va, vb] = [await seed.vehicle(a), await seed.vehicle(b)];
    await seed.alert(a, va);
    await seed.alert(a, va, { type: "mocked_location" });
    await seed.alert(a, va, { resolvedAt: new Date() });
    await seed.alert(b, vb);

    await expect(repository.countActiveAlerts(a)).resolves.toBe(2);
    await expect(repository.countActiveAlerts(b)).resolves.toBe(1);
    await expect(repository.countActiveAlerts(await seed.tenant())).resolves.toBe(0);
  });
});

describe("findStopped", () => {
  const query = (tenantId: string, overrides: Partial<Parameters<typeof repository.findStopped>[0]> = {}) =>
    repository.findStopped({
      tenantId,
      stoppedAtOrBefore: stoppedSinceCutoff(NOW, 20),
      signalSince: noSignalCutoff(NOW),
      zoneKind: undefined,
      limit: 50,
      ...overrides,
    });

  it("devuelve placa, posición (longitud y latitud en su orden), stoppedSince y la zona", async () => {
    const tenant = await seed.tenant();
    const zone = await seed.zone(tenant, { name: "Crítica Norte", kind: "critical" });
    const vehicle = await seed.vehicle(tenant, "ABC123");
    await seed.state(tenant, vehicle, { movement: "stopped", stoppedSince: minutesBefore(45), receivedAt: minutesBefore(1), zoneIds: [zone], ...OVERLAP_POINT });

    const rows = await query(tenant);

    expect(rows).toEqual([
      {
        vehicleId: vehicle,
        plate: "ABC123",
        stoppedSince: minutesBefore(45),
        lon: OVERLAP_POINT.lon,
        lat: OVERLAP_POINT.lat,
        zones: [{ zoneId: zone, name: "Crítica Norte", kind: "critical" }],
      },
    ]);
  });

  it("excluye los que se mueven, los que llevan menos del mínimo y los SIN SEÑAL (su duración mentiría)", async () => {
    const tenant = await seed.tenant();
    const [ok, moving, recent, noSignal] = [await seed.vehicle(tenant), await seed.vehicle(tenant), await seed.vehicle(tenant), await seed.vehicle(tenant)];
    await seed.state(tenant, ok, { movement: "stopped", stoppedSince: minutesBefore(25), receivedAt: minutesBefore(1) });
    await seed.state(tenant, moving, { movement: "moving", receivedAt: minutesBefore(1) });
    await seed.state(tenant, recent, { movement: "stopped", stoppedSince: minutesBefore(5), receivedAt: minutesBefore(1) });
    await seed.state(tenant, noSignal, { movement: "stopped", stoppedSince: minutesBefore(120), receivedAt: minutesBefore(60) });

    const rows = await query(tenant);

    expect(rows.map((row) => row.vehicleId)).toEqual([ok]);
  });

  it("los bordes: detenido exactamente el mínimo cuenta, un milisegundo menos no; con señal exactamente en el corte cuenta", async () => {
    const tenant = await seed.tenant();
    const [exact, justShort, signalEdge] = [await seed.vehicle(tenant), await seed.vehicle(tenant), await seed.vehicle(tenant)];
    await seed.state(tenant, exact, { movement: "stopped", stoppedSince: stoppedSinceCutoff(NOW, 20), receivedAt: minutesBefore(1) });
    await seed.state(tenant, justShort, { movement: "stopped", stoppedSince: new Date(stoppedSinceCutoff(NOW, 20).getTime() + 1), receivedAt: minutesBefore(1) });
    await seed.state(tenant, signalEdge, { movement: "stopped", stoppedSince: minutesBefore(60), receivedAt: noSignalCutoff(NOW) });

    const rows = await query(tenant);

    expect(rows.map((row) => row.vehicleId).sort()).toEqual([exact, signalEdge].sort());
  });

  it("los que llevan más tiempo primero, con desempate estable por vehicleId, y respeta el límite", async () => {
    const tenant = await seed.tenant();
    const since = minutesBefore(40);
    const sameTime = [await seed.vehicle(tenant), await seed.vehicle(tenant)];
    const oldest = await seed.vehicle(tenant);
    const newest = await seed.vehicle(tenant);
    await seed.state(tenant, newest, { movement: "stopped", stoppedSince: minutesBefore(25), receivedAt: minutesBefore(1) });
    for (const id of sameTime) await seed.state(tenant, id, { movement: "stopped", stoppedSince: since, receivedAt: minutesBefore(1) });
    await seed.state(tenant, oldest, { movement: "stopped", stoppedSince: minutesBefore(90), receivedAt: minutesBefore(1) });

    const all = (await query(tenant)).map((row) => row.vehicleId);

    expect(all).toEqual([oldest, ...[...sameTime].sort(), newest]);
    expect((await query(tenant)).map((row) => row.vehicleId)).toEqual(all);
    expect((await query(tenant, { limit: 2 })).map((row) => row.vehicleId)).toEqual(all.slice(0, 2));
  });

  describe("filtro por tipo de zona", () => {
    it("deja solo los detenidos en una zona de ese tipo y el filtro corre ANTES del límite", async () => {
      const tenant = await seed.tenant();
      const [critical, customer] = [await seed.zone(tenant, { kind: "critical" }), await seed.zone(tenant, { kind: "customer", wkt: BOGOTA_OVERLAP })];
      const inCustomerOnly = await seed.vehicle(tenant);
      // Tres detenidos MÁS antiguos en zona crítica: con un LIMIT 1 aplicado antes del filtro, el de cliente no aparecería.
      for (const minutes of [100, 90, 80]) await seed.state(tenant, await seed.vehicle(tenant), { movement: "stopped", stoppedSince: minutesBefore(minutes), receivedAt: minutesBefore(1), zoneIds: [critical] });
      await seed.state(tenant, inCustomerOnly, { movement: "stopped", stoppedSince: minutesBefore(30), receivedAt: minutesBefore(1), zoneIds: [customer] });

      const rows = await query(tenant, { zoneKind: "customer", limit: 1 });

      expect(rows.map((row) => row.vehicleId)).toEqual([inCustomerOnly]);
      expect(rows[0]?.zones.map((zone) => zone.kind)).toEqual(["customer"]);
    });

    it("excluye los detenidos fuera de toda zona, y sin filtro los incluye con zones vacío", async () => {
      const tenant = await seed.tenant();
      const outside = await seed.vehicle(tenant);
      await seed.state(tenant, outside, { movement: "stopped", stoppedSince: minutesBefore(45), receivedAt: minutesBefore(1), zoneIds: [] });

      expect(await query(tenant, { zoneKind: "critical" })).toEqual([]);
      expect((await query(tenant))[0]).toMatchObject({ vehicleId: outside, zones: [] });
    });

    it("un vehículo en varias zonas las trae todas (la crítica se elige en el dominio), o solo las del tipo pedido", async () => {
      const tenant = await seed.tenant();
      const [critical, depot] = [await seed.zone(tenant, { kind: "critical" }), await seed.zone(tenant, { kind: "depot", wkt: BOGOTA_OVERLAP })];
      const vehicle = await seed.vehicle(tenant);
      await seed.state(tenant, vehicle, { movement: "stopped", stoppedSince: minutesBefore(45), receivedAt: minutesBefore(1), zoneIds: [depot, critical], ...OVERLAP_POINT });

      const [unfiltered] = await query(tenant);
      const [onlyDepot] = await query(tenant, { zoneKind: "depot" });

      expect(unfiltered?.zones.map((zone) => zone.zoneId).sort()).toEqual([critical, depot].sort());
      expect(onlyDepot?.zones.map((zone) => zone.zoneId)).toEqual([depot]);
    });
  });

  it("aislamiento: no devuelve vehículos de otro tenant ni zonas de otro tenant aunque zone_ids las nombre", async () => {
    const [a, b] = [await seed.tenant(), await seed.tenant()];
    const foreignZone = await seed.zone(b, { name: "Zona ajena" });
    const mine = await seed.vehicle(a);
    await seed.state(a, mine, { movement: "stopped", stoppedSince: minutesBefore(45), receivedAt: minutesBefore(1), zoneIds: [foreignZone] });
    await seed.state(b, await seed.vehicle(b), { movement: "stopped", stoppedSince: minutesBefore(45), receivedAt: minutesBefore(1) });

    const rows = await query(a);

    expect(rows.map((row) => row.vehicleId)).toEqual([mine]);
    expect(JSON.stringify(rows)).not.toContain("Zona ajena");
    expect(rows[0]?.zones).toEqual([]);
    expect(await query(a, { zoneKind: "critical" })).toEqual([]);
  });
});

describe("findAlerts", () => {
  const find = (tenantId: string, overrides: Partial<Parameters<typeof repository.findAlerts>[0]> = {}) =>
    repository.findAlerts({ tenantId, status: "all", after: undefined, limit: 50, ...overrides });

  it("devuelve la alerta con la placa del vehículo y el nombre de la zona (JOIN), cumpliendo el contrato", async () => {
    const tenant = await seed.tenant();
    const zone = await seed.zone(tenant, { name: "Zona crítica Norte" });
    const vehicle = await seed.vehicle(tenant, "XYZ789");
    const alertId = await seed.alert(tenant, vehicle, { zoneId: zone, raisedAt: "2026-10-06T10:20:00.000Z" });

    const [record] = await find(tenant);

    expect(alertSchema.parse(record?.alert)).toMatchObject({
      alertId,
      vehicleId: vehicle,
      plate: "XYZ789",
      type: "critical_zone_stop",
      zoneId: zone,
      zoneName: "Zona crítica Norte",
      startedAt: "2026-10-06T10:00:00.000Z",
      raisedAt: "2026-10-06T10:20:00.000Z",
      resolvedAt: null,
    });
    expect(record?.alert.seq).toMatch(/^[1-9][0-9]*$/);
  });

  it("una alerta sin zona (mocked_location) tiene zoneId y zoneName null", async () => {
    const tenant = await seed.tenant();
    await seed.alert(tenant, await seed.vehicle(tenant), { type: "mocked_location" });

    const [record] = await find(tenant);

    expect(record?.alert).toMatchObject({ type: "mocked_location", zoneId: null, zoneName: null });
  });

  it("status active excluye las resueltas; all las incluye; de la más reciente a la más antigua", async () => {
    const tenant = await seed.tenant();
    const vehicle = await seed.vehicle(tenant);
    const oldest = await seed.alert(tenant, vehicle, { raisedAt: "2026-10-06T08:00:00.000Z" });
    const resolved = await seed.alert(tenant, vehicle, { raisedAt: "2026-10-06T09:00:00.000Z", resolvedAt: new Date("2026-10-06T09:30:00.000Z") });
    const newest = await seed.alert(tenant, vehicle, { raisedAt: "2026-10-06T10:00:00.000Z" });

    expect((await find(tenant, { status: "active" })).map((record) => record.alert.alertId)).toEqual([newest, oldest]);
    expect((await find(tenant, { status: "all" })).map((record) => record.alert.alertId)).toEqual([newest, resolved, oldest]);
    expect((await find(tenant, { status: "all" }))[1]?.alert.resolvedAt).toBe("2026-10-06T09:30:00.000Z");
  });

  it("keyset: recorre todas las páginas sin saltar ni repetir, también con alertas del MISMO milisegundo (distintos microsegundos) y del mismo instante exacto", async () => {
    const tenant = await seed.tenant();
    const vehicle = await seed.vehicle(tenant);
    // Cuatro con el mismo milisegundo y distinto microsegundo, y dos con el instante idéntico (desempata alert_id), más una anterior.
    const raisedAts = [
      "2026-10-06T10:00:00.000100Z",
      "2026-10-06T10:00:00.000200Z",
      "2026-10-06T10:00:00.000300Z",
      "2026-10-06T10:00:00.000400Z",
      "2026-10-06T10:00:00.000500Z",
      "2026-10-06T10:00:00.000500Z",
      "2026-10-06T09:59:59.999999Z",
    ];
    const created = new Set<string>();
    for (const raisedAt of raisedAts) created.add(await seed.alert(tenant, vehicle, { raisedAt }));

    const seen: string[] = [];
    let after: Parameters<typeof repository.findAlerts>[0]["after"];
    for (let page = 0; page < 20; page++) {
      const records = await find(tenant, { after, limit: 2 });
      seen.push(...records.map((record) => record.alert.alertId));
      const last = records.at(-1);
      if (records.length < 2 || last === undefined) break;
      after = last.cursor;
    }

    expect(seen).toHaveLength(raisedAts.length);
    expect(new Set(seen)).toEqual(created);
  });

  it("el cursor de cada alerta conserva los microsegundos de raised_at y su alertId", async () => {
    const tenant = await seed.tenant();
    const alertId = await seed.alert(tenant, await seed.vehicle(tenant), { raisedAt: "2026-10-06T10:00:00.123456Z" });

    const [record] = await find(tenant);

    expect(record?.cursor).toEqual({ raisedAt: "2026-10-06T10:00:00.123456Z", alertId });
  });

  it("respeta el límite (devuelve a lo sumo limit)", async () => {
    const tenant = await seed.tenant();
    const vehicle = await seed.vehicle(tenant);
    for (let i = 0; i < 5; i++) await seed.alert(tenant, vehicle, { raisedAt: `2026-10-06T10:00:0${i}.000Z` });

    expect(await find(tenant, { limit: 3 })).toHaveLength(3);
  });

  it("aislamiento: no devuelve alertas de otro tenant, con ni sin cursor", async () => {
    const [a, b] = [await seed.tenant(), await seed.tenant()];
    const mine = await seed.alert(a, await seed.vehicle(a), { raisedAt: "2026-10-06T10:00:00.000Z" });
    const theirs = await seed.alert(b, await seed.vehicle(b), { raisedAt: "2026-10-06T11:00:00.000Z" });

    expect((await find(a)).map((record) => record.alert.alertId)).toEqual([mine]);
    expect((await find(b)).map((record) => record.alert.alertId)).toEqual([theirs]);
    // Un cursor "posterior" a todo no deja ver lo de otro tenant.
    expect(await find(a, { after: { raisedAt: "2030-01-01T00:00:00.000000Z", alertId: randomUUID() } })).toHaveLength(1);
    expect((await find(a, { after: { raisedAt: "2030-01-01T00:00:00.000000Z", alertId: randomUUID() } }))[0]?.alert.alertId).toBe(mine);
  });
});

describe("findZones", () => {
  it("devuelve una FeatureCollection del contrato con las coordenadas [lng, lat]", async () => {
    const tenant = await seed.tenant();
    const zone = await seed.zone(tenant, { name: "Crítica", kind: "critical" });

    const collection = await repository.findZones(tenant);

    expect(zoneFeatureCollectionSchema.parse(collection)).toEqual(collection);
    expect(collection.features).toHaveLength(1);
    const [feature] = collection.features;
    expect(feature?.properties).toEqual({ zoneId: zone, name: "Crítica", kind: "critical" });
    const ring = feature?.geometry.coordinates[0] ?? [];
    // El primer vértice del polígono sembrado es (-74.075, 4.705): longitud primero. Un orden invertido daría 4.705 en la posición 0.
    expect(ring.every(([lng, lat]) => lng >= -74.08 && lng <= -74.06 && lat >= 4.7 && lat <= 4.72)).toBe(true);
    expect(ring[0]).toEqual(ring.at(-1));
  });

  it("el anillo exterior va en sentido antihorario (RFC 7946), aunque la zona se guardara en horario", async () => {
    const tenant = await seed.tenant();
    const clockwise = "POLYGON((-74.075 4.705, -74.075 4.715, -74.065 4.715, -74.065 4.705, -74.075 4.705))";
    await seed.zone(tenant, { wkt: clockwise });

    const ring = (await repository.findZones(tenant)).features[0]?.geometry.coordinates[0] ?? [];
    // Área con signo (fórmula del zapatero): positiva = antihorario.
    const area = ring.slice(0, -1).reduce((sum, [x1 = 0, y1 = 0], i) => {
      const [x2 = 0, y2 = 0] = ring[i + 1] ?? [];
      return sum + (x1 * y2 - x2 * y1);
    }, 0);

    expect(area).toBeGreaterThan(0);
  });

  it("solo las zonas del tenant, ordenadas por nombre", async () => {
    const [a, b] = [await seed.tenant(), await seed.tenant()];
    await seed.zone(a, { name: "Zeta" });
    await seed.zone(a, { name: "Alfa", kind: "depot" });
    await seed.zone(b, { name: "De otro tenant" });

    const names = (await repository.findZones(a)).features.map((feature) => feature.properties.name);

    expect(names).toEqual(["Alfa", "Zeta"]);
  });

  it("un tenant sin zonas da una FeatureCollection vacía", async () => {
    await expect(repository.findZones(await seed.tenant())).resolves.toEqual({ type: "FeatureCollection", features: [] });
  });

  it("el tope de zonas es un LIMIT explícito", () => {
    expect(MAX_ZONES).toBeGreaterThan(0);
  });
});
