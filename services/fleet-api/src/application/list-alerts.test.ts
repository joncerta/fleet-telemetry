import { randomUUID } from "node:crypto";
import type { Alert } from "@fleet/contracts";
import { describe, expect, it, vi } from "vitest";
import { createListAlerts } from "./list-alerts.js";
import type { AlertReader, AlertRecord } from "./ports.js";

const record = (n: number): AlertRecord => {
  const alertId = randomUUID();
  const alert: Alert = {
    alertId,
    vehicleId: randomUUID(),
    plate: `P${n}`,
    type: "critical_zone_stop",
    zoneId: null,
    zoneName: null,
    startedAt: "2026-10-06T10:00:00.000Z",
    raisedAt: "2026-10-06T10:20:00.000Z",
    resolvedAt: null,
    seq: String(n),
  };
  return { alert, cursor: { raisedAt: `2026-10-06T10:20:00.${String(n).padStart(6, "0")}Z`, alertId } };
};

function makeUseCase(records: AlertRecord[]) {
  const findAlerts = vi.fn<AlertReader["findAlerts"]>().mockResolvedValue(records);
  return { findAlerts, listAlerts: createListAlerts({ reader: { findAlerts } }) };
}

describe("createListAlerts", () => {
  it("pide limit + 1 al lector y devuelve solo limit, con next igual a la posición de la última devuelta", async () => {
    const records = [record(3), record(2), record(1)];
    const { findAlerts, listAlerts } = makeUseCase(records);
    const tenantId = randomUUID();

    const page = await listAlerts({ tenantId, status: "active", limit: 2 });

    expect(findAlerts).toHaveBeenCalledWith({ tenantId, status: "active", after: undefined, limit: 3 });
    expect(page.items).toEqual([records[0]?.alert, records[1]?.alert]);
    expect(page.next).toEqual(records[1]?.cursor);
  });

  it("sin más páginas next es null", async () => {
    const records = [record(2), record(1)];
    const { listAlerts } = makeUseCase(records);

    const page = await listAlerts({ tenantId: randomUUID(), status: "all", limit: 2 });

    expect(page.items).toHaveLength(2);
    expect(page.next).toBeNull();
  });

  it("una lista vacía da items vacío y next null", async () => {
    const page = await makeUseCase([]).listAlerts({ tenantId: randomUUID(), status: "all", limit: 50 });

    expect(page).toEqual({ items: [], next: null });
  });

  it("pasa la posición `after` al lector para continuar después de ella", async () => {
    const { findAlerts, listAlerts } = makeUseCase([]);
    const after = { raisedAt: "2026-10-06T10:20:00.000123Z", alertId: randomUUID() };

    await listAlerts({ tenantId: randomUUID(), status: "active", limit: 5, after });

    expect(findAlerts).toHaveBeenCalledWith(expect.objectContaining({ after, limit: 6 }));
  });
});
