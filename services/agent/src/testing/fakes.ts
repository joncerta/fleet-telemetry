import { randomUUID } from "node:crypto";
import type { AlertsResponseTolerant, FleetSummary, StoppedVehiclesResponseTolerant } from "@fleet/contracts";
import { vi } from "vitest";
import { createGetActiveAlerts } from "../application/get-active-alerts.js";
import { createGetFleetSummary } from "../application/get-fleet-summary.js";
import { createGetStoppedVehicles } from "../application/get-stopped-vehicles.js";
import type { FleetData, FleetResult, UserContext } from "../application/ports.js";
import { SYSTEM_PROMPT } from "../application/system-prompt.js";
import { createLangChainChatAgent } from "../infrastructure/langchain-chat-agent.js";
import { ScriptedChatModel } from "../infrastructure/scripted-chat-model.js";
import { createFleetTools } from "../interfaces/agent/tools.js";

/** Soporte de los tests: fakes de los puertos y el agente real (createAgent) con el modelo con guion. No forma parte del build. */

export const B1_QUESTION = "¿Qué vehículos llevan detenidos más de 20 minutos en zonas críticas?";

export const CONTEXT: UserContext = {
  identity: { userId: randomUUID(), tenantId: randomUUID() },
  sessionToken: "token-de-sesion-firmado",
  correlationId: "corr-test-1",
};

export const STOPPED: StoppedVehiclesResponseTolerant = {
  serverTime: "2026-10-06T12:00:00.000Z",
  items: [
    {
      vehicleId: randomUUID(),
      plate: "ABC123",
      stoppedSince: "2026-10-06T11:37:00.000Z",
      stoppedMinutes: 23,
      lon: -74.0721,
      lat: 4.711,
      zone: { zoneId: randomUUID(), name: "Zona crítica Norte 1", kind: "critical" },
    },
  ],
};

export const SUMMARY: FleetSummary = { serverTime: "2026-10-06T12:00:00.000Z", vehicles: { total: 30, moving: 20, stopped: 7, noSignal: 3 }, activeAlerts: 2 };

export const ALERTS: AlertsResponseTolerant = {
  items: [
    {
      alertId: randomUUID(),
      vehicleId: randomUUID(),
      plate: "XYZ789",
      type: "critical_zone_stop",
      zoneId: randomUUID(),
      zoneName: "Zona crítica Sur 2",
      startedAt: "2026-10-06T11:00:00.000Z",
      raisedAt: "2026-10-06T11:20:00.000Z",
      resolvedAt: null,
      seq: "42",
    },
  ],
  nextCursor: null,
};

interface FleetOverrides {
  stoppedVehicles?: FleetResult<StoppedVehiclesResponseTolerant>;
  fleetSummary?: FleetResult<FleetSummary>;
  activeAlerts?: FleetResult<AlertsResponseTolerant>;
}

/** `FleetData` falso: cada método responde lo que se le diga (por defecto, datos de ejemplo) y se puede inspeccionar con `vi`. */
export function makeFleet(overrides: FleetOverrides = {}) {
  return {
    stoppedVehicles: vi.fn<FleetData["stoppedVehicles"]>(() => Promise.resolve(overrides.stoppedVehicles ?? { kind: "ok", data: STOPPED })),
    fleetSummary: vi.fn<FleetData["fleetSummary"]>(() => Promise.resolve(overrides.fleetSummary ?? { kind: "ok", data: SUMMARY })),
    activeAlerts: vi.fn<FleetData["activeAlerts"]>(() => Promise.resolve(overrides.activeAlerts ?? { kind: "ok", data: ALERTS })),
  } satisfies FleetData;
}

/** El agente REAL (`createAgent`, herramientas, casos de uso) con el modelo con guion sobre un `FleetData` dado. */
export function makeScriptedAgent(fleet: FleetData, options: { maxIterations?: number; timeoutMs?: number; onToolError?: (toolName: string, error: unknown) => void } = {}) {
  const useCases = {
    getStoppedVehicles: createGetStoppedVehicles({ fleet }),
    getFleetSummary: createGetFleetSummary({ fleet }),
    getActiveAlerts: createGetActiveAlerts({ fleet }),
  };
  return createLangChainChatAgent({
    model: new ScriptedChatModel(),
    systemPrompt: SYSTEM_PROMPT,
    maxIterations: options.maxIterations ?? 6,
    timeoutMs: options.timeoutMs ?? 30_000,
    modelName: "scripted",
    toolsFor: ({ context, record }) => createFleetTools({ ...useCases, context, record, onError: options.onToolError ?? (() => undefined) }),
  });
}
