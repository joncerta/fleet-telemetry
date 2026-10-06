import { randomUUID } from "node:crypto";
import { zoneCreateRequestSchema, zoneFeatureSchema, type ZoneFeature } from "@fleet/contracts";
import { describe, expect, it, vi } from "vitest";
import { createCreateZone } from "./create-zone.js";
import { InvalidZoneGeometryError, ZoneLimitReachedError, ZoneNameTakenError } from "./errors.js";
import type { CreateZoneResult, ZoneRepository } from "./ports.js";

const identity = { userId: randomUUID(), tenantId: randomUUID() };
const zoneId = randomUUID();

const ring: [number, number][] = [
  [-74.08, 4.7],
  [-74.07, 4.7],
  [-74.07, 4.71],
  [-74.08, 4.71],
  [-74.08, 4.7],
];
const request = zoneCreateRequestSchema.parse({ name: "  Zona crítica Norte  ", kind: "critical", geometry: { type: "Polygon", coordinates: [ring] } });

const stored: ZoneFeature = {
  type: "Feature",
  geometry: { type: "Polygon", coordinates: [ring] },
  properties: { zoneId, name: "Zona crítica Norte", kind: "critical" },
};

function makeZones(result: CreateZoneResult) {
  const create = vi.fn<ZoneRepository["create"]>(() => Promise.resolve(result));
  return { create, zones: { create } satisfies ZoneRepository };
}

describe("createCreateZone", () => {
  it("crea la zona en el tenant de la SESIÓN con un id generado por el servidor y devuelve el Feature", async () => {
    const { create, zones } = makeZones({ status: "created", zone: stored });
    const createZone = createCreateZone({ zones, newZoneId: () => zoneId, maxPerTenant: 7 });

    const zone = await createZone({ identity, zone: request });

    expect(zoneFeatureSchema.parse(zone)).toEqual(stored);
    expect(create).toHaveBeenCalledExactlyOnceWith({
      tenantId: identity.tenantId,
      zoneId,
      maxPerTenant: 7,
      name: "Zona crítica Norte",
      kind: "critical",
      geometry: { type: "Polygon", coordinates: [ring] },
    });
  });

  it("un nombre ya existente en el tenant es ZoneNameTakenError, sin el nombre en el mensaje", async () => {
    const { zones } = makeZones({ status: "name_taken" });
    const createZone = createCreateZone({ zones, newZoneId: () => zoneId, maxPerTenant: 7 });

    const failure = await createZone({ identity, zone: request }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ZoneNameTakenError);
    expect(failure instanceof Error ? failure.message : "").not.toContain("Norte");
  });

  it("un tenant que ya tiene el máximo de zonas es ZoneLimitReachedError", async () => {
    const { zones } = makeZones({ status: "limit_reached" });
    const createZone = createCreateZone({ zones, newZoneId: () => zoneId, maxPerTenant: 7 });

    await expect(createZone({ identity, zone: request })).rejects.toBeInstanceOf(ZoneLimitReachedError);
  });

  it("un polígono que PostGIS rechaza es InvalidZoneGeometryError", async () => {
    const { zones } = makeZones({ status: "invalid_geometry" });
    const createZone = createCreateZone({ zones, newZoneId: () => zoneId, maxPerTenant: 7 });

    await expect(createZone({ identity, zone: request })).rejects.toBeInstanceOf(InvalidZoneGeometryError);
  });

  it("un fallo del repositorio se propaga tal cual (no se confunde con un error de negocio)", async () => {
    const boom = new Error("conexión perdida");
    const createZone = createCreateZone({ zones: { create: () => Promise.reject(boom) }, newZoneId: () => zoneId, maxPerTenant: 7 });

    await expect(createZone({ identity, zone: request })).rejects.toBe(boom);
  });
});
