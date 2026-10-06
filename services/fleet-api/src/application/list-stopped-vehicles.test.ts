import { randomUUID } from "node:crypto";
import { stoppedVehiclesResponseSchema } from "@fleet/contracts";
import { describe, expect, it, vi } from "vitest";
import { createListStoppedVehicles } from "./list-stopped-vehicles.js";
import type { StoppedVehicleReader, StoppedVehicleRow } from "./ports.js";

const NOW = new Date("2026-10-06T12:00:00.000Z");
const clock = { now: () => NOW };

const critical = { zoneId: randomUUID(), name: "Crítica", kind: "critical" } as const;
const depot = { zoneId: randomUUID(), name: "Depósito", kind: "depot" } as const;

const row = (overrides: Partial<StoppedVehicleRow> = {}): StoppedVehicleRow => ({
  vehicleId: randomUUID(),
  plate: "ABC123",
  stoppedSince: new Date("2026-10-06T11:30:00.000Z"),
  lon: -74.07,
  lat: 4.71,
  zones: [critical],
  ...overrides,
});

function makeUseCase(rows: StoppedVehicleRow[]) {
  const findStopped = vi.fn<StoppedVehicleReader["findStopped"]>().mockResolvedValue(rows);
  return { findStopped, listStopped: createListStoppedVehicles({ reader: { findStopped }, clock }) };
}

describe("createListStoppedVehicles", () => {
  it("convierte los minutos con la hora del servidor y la respuesta cumple el contrato", async () => {
    const { listStopped } = makeUseCase([row()]);

    const response = await listStopped({ tenantId: randomUUID(), minMinutes: 20, limit: 50, zoneKind: undefined });

    expect(stoppedVehiclesResponseSchema.parse(response).items[0]).toMatchObject({ stoppedMinutes: 30, stoppedSince: "2026-10-06T11:30:00.000Z", zone: critical });
    expect(response.serverTime).toBe("2026-10-06T12:00:00.000Z");
  });

  it("pide al lector solo ese tenant, los detenidos al menos minMinutes y los que tienen señal (corte de 5 min)", async () => {
    const { findStopped, listStopped } = makeUseCase([]);
    const tenantId = randomUUID();

    await listStopped({ tenantId, minMinutes: 20, limit: 10, zoneKind: "critical" });

    expect(findStopped).toHaveBeenCalledWith({
      tenantId,
      stoppedAtOrBefore: new Date("2026-10-06T11:40:00.000Z"),
      signalSince: new Date("2026-10-06T11:55:00.000Z"),
      zoneKind: "critical",
      limit: 10,
    });
  });

  it("con varias zonas muestra la crítica primero", async () => {
    const { listStopped } = makeUseCase([row({ zones: [depot, critical] })]);

    const response = await listStopped({ tenantId: randomUUID(), minMinutes: 1, limit: 5, zoneKind: undefined });

    expect(response.items[0]?.zone).toEqual(critical);
  });

  it("un vehículo detenido fuera de toda zona tiene zone null", async () => {
    const { listStopped } = makeUseCase([row({ zones: [] })]);

    const response = await listStopped({ tenantId: randomUUID(), minMinutes: 1, limit: 5, zoneKind: undefined });

    expect(response.items[0]?.zone).toBeNull();
  });

  it("conserva el orden del lector (los que llevan más tiempo primero)", async () => {
    const [older, newer] = [row({ stoppedSince: new Date("2026-10-06T10:00:00.000Z") }), row({ stoppedSince: new Date("2026-10-06T11:00:00.000Z") })];
    const { listStopped } = makeUseCase([older, newer]);

    const response = await listStopped({ tenantId: randomUUID(), minMinutes: 1, limit: 5, zoneKind: undefined });

    expect(response.items.map((item) => item.vehicleId)).toEqual([older.vehicleId, newer.vehicleId]);
    expect(response.items.map((item) => item.stoppedMinutes)).toEqual([120, 60]);
  });
});
