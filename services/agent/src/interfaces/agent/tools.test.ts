import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createGetActiveAlerts } from "../../application/get-active-alerts.js";
import { createGetFleetSummary } from "../../application/get-fleet-summary.js";
import { createGetStoppedVehicles } from "../../application/get-stopped-vehicles.js";
import type { ToolCallRecord } from "../../application/ports.js";
import { toolResultSchema } from "../../application/tool-result.js";
import { CONTEXT, makeFleet } from "../../testing/fakes.js";
import { activeAlertsToolSchema, createFleetTools, fleetSummaryToolSchema, stoppedVehiclesToolSchema } from "./tools.js";

function makeTools(fleet = makeFleet()) {
  const records: ToolCallRecord[] = [];
  const errors: { toolName: string; error: unknown }[] = [];
  const [stopped, summary, alerts] = createFleetTools({
    getStoppedVehicles: createGetStoppedVehicles({ fleet }),
    getFleetSummary: createGetFleetSummary({ fleet }),
    getActiveAlerts: createGetActiveAlerts({ fleet }),
    context: CONTEXT,
    record: (call) => records.push(call),
    onError: (toolName, error) => errors.push({ toolName, error }),
  });
  return { fleet, records, errors, stopped, summary, alerts };
}

describe("esquemas de las herramientas", () => {
  it("get_stopped_vehicles: aplica los valores por defecto (20 minutos, 20 filas)", () => {
    expect(stoppedVehiclesToolSchema.parse({})).toEqual({ minMinutes: 20, limit: 20 });
  });

  it.each([
    [{ minMinutes: 0 }],
    [{ minMinutes: 1441 }],
    [{ minMinutes: 20.5 }],
    [{ minMinutes: "20" }],
    [{ limit: 0 }],
    [{ limit: 51 }],
    [{ zoneKind: "airport" }],
  ])("get_stopped_vehicles rechaza %j", (input) => {
    expect(stoppedVehiclesToolSchema.safeParse(input).success).toBe(false);
  });

  it("get_stopped_vehicles acepta los extremos del rango y los tres tipos de zona", () => {
    expect(stoppedVehiclesToolSchema.safeParse({ minMinutes: 1, limit: 1 }).success).toBe(true);
    expect(stoppedVehiclesToolSchema.safeParse({ minMinutes: 1440, limit: 50 }).success).toBe(true);
    for (const zoneKind of ["critical", "depot", "customer"]) expect(stoppedVehiclesToolSchema.safeParse({ zoneKind }).success).toBe(true);
  });

  it("get_active_alerts acota limit de 1 a 50 con 20 por defecto", () => {
    expect(activeAlertsToolSchema.parse({})).toEqual({ limit: 20 });
    expect(activeAlertsToolSchema.safeParse({ limit: 51 }).success).toBe(false);
    expect(activeAlertsToolSchema.safeParse({ limit: 0 }).success).toBe(false);
  });

  it("ninguna herramienta expone tenantId, cookie ni identidad como argumento del LLM", () => {
    for (const schema of [stoppedVehiclesToolSchema, fleetSummaryToolSchema, activeAlertsToolSchema]) {
      expect(Object.keys(schema.shape)).not.toEqual(expect.arrayContaining(["tenantId"]));
      expect(Object.keys(schema.shape).join(",")).not.toMatch(/tenant|cookie|session|user|identity|token/i);
    }
  });

  it("un tenantId que el LLM mande se descarta del esquema: no llega al caso de uso", () => {
    const parsed = stoppedVehiclesToolSchema.parse({ minMinutes: 30, tenantId: "00000000-0000-4000-8000-000000000001" });

    expect(parsed).toEqual({ minMinutes: 30, limit: 20 });
  });
});

describe("herramientas", () => {
  it("get_stopped_vehicles llama al caso de uso con la sesión del servidor y los argumentos validados", async () => {
    const { fleet, stopped } = makeTools();

    const output = await stopped.invoke({ minMinutes: 20, zoneKind: "critical" });

    expect(fleet.stoppedVehicles).toHaveBeenCalledWith(CONTEXT, { minMinutes: 20, zoneKind: "critical", limit: 20 });
    const result = toolResultSchema.parse(JSON.parse(String(output)));
    expect(result.status).toBe("ok");
  });

  it("la sesión nunca está en el esquema que ve el LLM ni en lo que la herramienta le devuelve", async () => {
    const { stopped, summary, alerts } = makeTools();

    for (const candidate of [stopped, summary, alerts]) {
      expect(JSON.stringify(candidate.schema)).not.toMatch(/tenant|cookie|session|userId|token/i);
    }
    const output = String(await stopped.invoke({}));
    expect(output).not.toContain(CONTEXT.sessionToken);
    expect(output).not.toContain(CONTEXT.identity.tenantId);
    expect(output).not.toContain(CONTEXT.identity.userId);
  });

  it("rechaza argumentos fuera de los límites del esquema antes de llegar a fleet-api", async () => {
    const { fleet, stopped, alerts } = makeTools();

    await expect(stopped.invoke({ minMinutes: 5000 })).rejects.toThrow();
    await expect(stopped.invoke({ limit: 500 })).rejects.toThrow();
    await expect(alerts.invoke({ limit: 0 })).rejects.toThrow();

    expect(fleet.stoppedVehicles).not.toHaveBeenCalled();
    expect(fleet.activeAlerts).not.toHaveBeenCalled();
  });

  it("registra nombre, entrada validada (con los valores por defecto, sin la sesión), estado y duración", async () => {
    const { records, stopped, summary, alerts } = makeTools();

    await stopped.invoke({ zoneKind: "critical" });
    await summary.invoke({});
    await alerts.invoke({ limit: 5 });

    expect(records).toEqual([
      { name: "get_stopped_vehicles", input: { minMinutes: 20, zoneKind: "critical", limit: 20 }, status: "ok", durationMs: expect.any(Number) as number },
      { name: "get_fleet_summary", input: {}, status: "ok", durationMs: expect.any(Number) as number },
      { name: "get_active_alerts", input: { limit: 5 }, status: "ok", durationMs: expect.any(Number) as number },
    ]);
    expect(JSON.stringify(records)).not.toMatch(/tenant|cookie|session|token/i);
  });

  it("omite del input registrado los opcionales ausentes (no hay undefined en el JSON)", async () => {
    const { records, stopped } = makeTools();

    await stopped.invoke({});

    expect(records[0]?.input).toEqual({ minMinutes: 20, limit: 20 });
    expect(Object.keys(records[0]?.input ?? {})).not.toContain("zoneKind");
  });

  it("fleet-api no disponible: devuelve status unavailable con el mensaje del fallback, sin datos, y lo registra como error", async () => {
    const { records, stopped } = makeTools(makeFleet({ stoppedVehicles: { kind: "unavailable", reason: "breaker_open" } }));

    const result = toolResultSchema.parse(JSON.parse(String(await stopped.invoke({}))));

    expect(result).toEqual({ status: "unavailable", reason: "breaker_open", message: expect.stringContaining("breaker abierto") as string });
    expect(JSON.stringify(result)).not.toContain("data");
    expect(records[0]).toMatchObject({ name: "get_stopped_vehicles", status: "error" });
  });

  it("un 4xx de fleet-api: status rejected, sin datos, registrado como error", async () => {
    const { records, summary } = makeTools(makeFleet({ fleetSummary: { kind: "rejected", status: 401 } }));

    const result = toolResultSchema.parse(JSON.parse(String(await summary.invoke({}))));

    expect(result.status).toBe("rejected");
    expect(records[0]?.status).toBe("error");
  });

  it("una excepción del caso de uso no sube al agente: se devuelve como fallo y se registra", async () => {
    const fleet = makeFleet();
    fleet.activeAlerts.mockRejectedValueOnce(new Error("detalle interno con un secreto"));
    const { records, errors, alerts } = makeTools(fleet);

    const output = String(await alerts.invoke({}));

    expect(toolResultSchema.parse(JSON.parse(output)).status).toBe("unavailable");
    expect(output).not.toContain("secreto");
    expect(records[0]?.status).toBe("error");
    // No se traga: se avisa (con el nombre de la herramienta) para que quede en el log.
    expect(errors).toEqual([{ toolName: "get_active_alerts", error: expect.any(Error) as Error }]);
  });

  it("parsea el resultado con límites: no pasa de 50 filas aunque fleet-api devuelva más", async () => {
    const many = {
      serverTime: "2026-10-06T12:00:00.000Z",
      items: Array.from({ length: 120 }, (_, index) => ({
        vehicleId: crypto.randomUUID(),
        plate: `P${index}`,
        stoppedSince: "2026-10-06T10:00:00.000Z",
        stoppedMinutes: 120,
        lon: -74,
        lat: 4,
        zone: null,
      })),
    };
    const { stopped } = makeTools(makeFleet({ stoppedVehicles: { kind: "ok", data: many } }));

    const result = toolResultSchema.parse(JSON.parse(String(await stopped.invoke({ limit: 50 }))));

    expect(result.status).toBe("ok");
    expect(z.object({ count: z.number() }).parse(result.status === "ok" ? result.data : {}).count).toBe(50);
  });

  it("el cliente recibe el limit validado (get_active_alerts)", async () => {
    const fleet = makeFleet();
    const spy = vi.spyOn(fleet, "activeAlerts");
    const { alerts } = makeTools(fleet);

    await alerts.invoke({ limit: 7 });

    expect(spy).toHaveBeenCalledWith(CONTEXT, { limit: 7 });
  });
});
