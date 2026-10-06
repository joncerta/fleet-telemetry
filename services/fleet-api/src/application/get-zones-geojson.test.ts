import { randomUUID } from "node:crypto";
import type { ZoneFeatureCollection } from "@fleet/contracts";
import { describe, expect, it, vi } from "vitest";
import { createGetZonesGeoJson } from "./get-zones-geojson.js";

describe("createGetZonesGeoJson", () => {
  it("devuelve lo que lee el lector, pidiendo SOLO las zonas del tenant recibido", async () => {
    const collection: ZoneFeatureCollection = { type: "FeatureCollection", features: [] };
    const findZones = vi.fn().mockResolvedValue(collection);
    const tenantId = randomUUID();

    await expect(createGetZonesGeoJson({ reader: { findZones } })({ tenantId })).resolves.toBe(collection);

    expect(findZones).toHaveBeenCalledExactlyOnceWith(tenantId);
  });
});
