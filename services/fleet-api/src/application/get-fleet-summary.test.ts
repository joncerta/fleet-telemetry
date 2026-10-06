import { randomUUID } from "node:crypto";
import { fleetSummarySchema } from "@fleet/contracts";
import { describe, expect, it, vi } from "vitest";
import { createGetFleetSummary } from "./get-fleet-summary.js";
import type { SummaryReader } from "./ports.js";

const NOW = new Date("2026-10-06T12:00:00.000Z");
const clock = { now: () => NOW };

function makeReader(counts = { moving: 3, stopped: 2, noSignal: 1 }, activeAlerts = 4) {
  const countVehicleStatus = vi.fn<SummaryReader["countVehicleStatus"]>().mockResolvedValue(counts);
  const countActiveAlerts = vi.fn<SummaryReader["countActiveAlerts"]>().mockResolvedValue(activeAlerts);
  return { reader: { countVehicleStatus, countActiveAlerts } satisfies SummaryReader, countVehicleStatus, countActiveAlerts };
}

describe("createGetFleetSummary", () => {
  it("total es moving + stopped + noSignal y la respuesta cumple el contrato", async () => {
    const summary = await createGetFleetSummary({ reader: makeReader().reader, clock })({ tenantId: randomUUID() });

    expect(fleetSummarySchema.parse(summary)).toEqual({
      serverTime: "2026-10-06T12:00:00.000Z",
      vehicles: { total: 6, moving: 3, stopped: 2, noSignal: 1 },
      activeAlerts: 4,
    });
  });

  it("consulta SOLO el tenant que recibe, con el corte de sin señal a 5 minutos de la hora del servidor", async () => {
    const { reader, countVehicleStatus, countActiveAlerts } = makeReader();
    const tenantId = randomUUID();

    await createGetFleetSummary({ reader, clock })({ tenantId });

    expect(countVehicleStatus).toHaveBeenCalledWith(tenantId, new Date("2026-10-06T11:55:00.000Z"));
    expect(countActiveAlerts).toHaveBeenCalledWith(tenantId);
  });

  it("una flota vacía da ceros", async () => {
    const summary = await createGetFleetSummary({ reader: makeReader({ moving: 0, stopped: 0, noSignal: 0 }, 0).reader, clock })({ tenantId: randomUUID() });

    expect(summary.vehicles).toEqual({ total: 0, moving: 0, stopped: 0, noSignal: 0 });
  });

  it("un fallo del lector se propaga", async () => {
    const reader: SummaryReader = { countVehicleStatus: () => Promise.reject(new Error("boom")), countActiveAlerts: vi.fn().mockResolvedValue(0) };

    await expect(createGetFleetSummary({ reader, clock })({ tenantId: randomUUID() })).rejects.toThrow("boom");
  });
});
