import { randomUUID } from "node:crypto";
import type { ZoneCreateRequest } from "@fleet/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIntegrationDatabase, createSeeder, type IntegrationDatabase, type Seeder } from "../testing/integration-db.js";
import { createPgFleetReadRepository } from "./pg-fleet-read-repository.js";
import { createPgZoneRepository } from "./pg-zone-repository.js";

// Contra la base real (TimescaleDB + PostGIS), con el rol de los servicios (fleet_app): la inserción con ST_GeomFromGeoJSON (longitud primero,
// SRID 4326), la unicidad (tenant, nombre), el polígono auto-intersectado, el aislamiento entre tenants y que la zona aparezca en la lectura
// de `GET /v1/zones/geojson` (`findZones`).
let db: IntegrationDatabase;
let seed: Seeder;

beforeAll(async () => {
  db = await createIntegrationDatabase("fleet-api-zones-it");
  seed = createSeeder(db.pool);
});

afterAll(async () => {
  await db?.close();
});

const zones = () => createPgZoneRepository(db.pool);
const reader = () => createPgFleetReadRepository(db.pool);

const ring: [number, number][] = [
  [-74.08, 4.7],
  [-74.07, 4.7],
  [-74.07, 4.71],
  [-74.08, 4.71],
  [-74.08, 4.7],
];
const geometry = (coordinates: [number, number][] = ring): ZoneCreateRequest["geometry"] => ({ type: "Polygon", coordinates: [coordinates] });
// Moño: el borde se cruza consigo mismo (inválido para PostGIS aunque cumpla el esquema del contrato).
const BOW_TIE: [number, number][] = [
  [-74.08, 4.7],
  [-74.07, 4.71],
  [-74.07, 4.7],
  [-74.08, 4.71],
  [-74.08, 4.7],
];

const input = (tenantId: string, overrides: Partial<{ zoneId: string; name: string; kind: "critical" | "depot" | "customer" }> = {}) => ({
  tenantId,
  zoneId: overrides.zoneId ?? randomUUID(),
  name: overrides.name ?? `Zona ${randomUUID()}`,
  kind: overrides.kind ?? "critical",
  geometry: geometry(),
});

describe("createPgZoneRepository.create", () => {
  it("inserta la zona en el tenant y devuelve el Feature con coordenadas [lng, lat], SRID 4326 y el id del servidor", async () => {
    const tenantId = await seed.tenant();
    const zoneId = randomUUID();

    const result = await zones().create(input(tenantId, { zoneId, name: "Depósito Norte", kind: "depot" }));

    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    expect(result.zone.properties).toEqual({ zoneId, name: "Depósito Norte", kind: "depot" });
    // El anillo exterior sale antihorario (como en `findZones`); el conjunto de vértices es el enviado y la longitud (negativa) va primero.
    const [exterior] = result.zone.geometry.coordinates;
    expect(exterior).toHaveLength(5);
    expect(exterior?.every(([lng, lat]) => lng < -70 && lat > 4 && lat < 5)).toBe(true);
    const stored = await db.pool.query<{ tenant_id: string; srid: number; valid: boolean; lon: number }>(
      "SELECT tenant_id, ST_SRID(geom) AS srid, ST_IsValid(geom) AS valid, ST_X(ST_PointOnSurface(geom)) AS lon FROM zones WHERE zone_id = $1",
      [zoneId],
    );
    expect(stored.rows[0]).toMatchObject({ tenant_id: tenantId, srid: 4326, valid: true });
    expect(stored.rows[0]?.lon).toBeLessThan(-74);
  });

  it("un nombre repetido en el mismo tenant es name_taken y no inserta nada", async () => {
    const tenantId = await seed.tenant();
    await zones().create(input(tenantId, { name: "Duplicada" }));

    const second = await zones().create(input(tenantId, { name: "Duplicada", kind: "customer" }));

    expect(second).toEqual({ status: "name_taken" });
    const count = await db.pool.query<{ n: string }>("SELECT count(*) AS n FROM zones WHERE tenant_id = $1 AND name = 'Duplicada'", [tenantId]);
    expect(Number(count.rows[0]?.n)).toBe(1);
  });

  it("el mismo nombre en OTRO tenant es válido", async () => {
    const [a, b] = [await seed.tenant(), await seed.tenant()];

    expect((await zones().create(input(a, { name: "Compartida" }))).status).toBe("created");
    expect((await zones().create(input(b, { name: "Compartida" }))).status).toBe("created");
  });

  it("dos altas simultáneas del mismo nombre: una gana y las demás son name_taken (sin error de pg)", async () => {
    const tenantId = await seed.tenant();

    const results = await Promise.all(Array.from({ length: 4 }, () => zones().create(input(tenantId, { name: "Carrera" }))));

    expect(results.filter((result) => result.status === "created")).toHaveLength(1);
    expect(results.filter((result) => result.status === "name_taken")).toHaveLength(3);
  });

  it("un polígono auto-intersectado es invalid_geometry (sin lanzar) y no inserta nada", async () => {
    const tenantId = await seed.tenant();

    const result = await zones().create({ ...input(tenantId, { name: "Moño" }), geometry: geometry(BOW_TIE) });

    expect(result).toEqual({ status: "invalid_geometry" });
    const count = await db.pool.query<{ n: string }>("SELECT count(*) AS n FROM zones WHERE tenant_id = $1", [tenantId]);
    expect(Number(count.rows[0]?.n)).toBe(0);
  });

  it("tras un invalid_geometry el mismo nombre sigue libre para un polígono válido", async () => {
    const tenantId = await seed.tenant();
    await zones().create({ ...input(tenantId, { name: "Reintento" }), geometry: geometry(BOW_TIE) });

    expect((await zones().create(input(tenantId, { name: "Reintento" }))).status).toBe("created");
  });

  it("un nombre con forma de inyección SQL se guarda como dato", async () => {
    const tenantId = await seed.tenant();
    const name = "X'; DROP TABLE zones;--";

    const result = await zones().create(input(tenantId, { name }));

    expect(result.status).toBe("created");
    await expect(db.pool.query("SELECT 1 FROM zones LIMIT 1")).resolves.toBeDefined();
    expect((await reader().findZones(tenantId)).features.map((feature) => feature.properties.name)).toEqual([name]);
  });
});

describe("la zona creada en la lectura de zonas", () => {
  it("aparece en findZones del mismo tenant y NO en el de otro", async () => {
    const [a, b] = [await seed.tenant(), await seed.tenant()];
    const zoneId = randomUUID();
    await zones().create(input(a, { zoneId, name: "Solo de A", kind: "critical" }));

    const own = await reader().findZones(a);
    const other = await reader().findZones(b);

    expect(own.features.map((feature) => feature.properties)).toEqual([{ zoneId, name: "Solo de A", kind: "critical" }]);
    expect(other.features).toEqual([]);
  });

  it("la zona creada contiene un punto dentro (ST_Covers con la longitud primero) y no uno con lat y lon invertidos", async () => {
    const tenantId = await seed.tenant();
    const zoneId = randomUUID();
    await zones().create(input(tenantId, { zoneId, name: "Cubre" }));

    const inside = await db.pool.query<{ covers: boolean }>(
      "SELECT ST_Covers(geom, ST_SetSRID(ST_MakePoint($2, $3), 4326)) AS covers FROM zones WHERE zone_id = $1",
      [zoneId, -74.075, 4.705],
    );
    const swapped = await db.pool.query<{ covers: boolean }>(
      "SELECT ST_Covers(geom, ST_SetSRID(ST_MakePoint($2, $3), 4326)) AS covers FROM zones WHERE zone_id = $1",
      [zoneId, 4.705, -74.075],
    );

    expect(inside.rows[0]?.covers).toBe(true);
    expect(swapped.rows[0]?.covers).toBe(false);
  });
});
