import { ZONE_KINDS } from "@fleet/contracts";
import { tool } from "langchain";
import { z } from "zod";
import type { GetActiveAlerts } from "../../application/get-active-alerts.js";
import type { GetFleetSummary } from "../../application/get-fleet-summary.js";
import type { GetStoppedVehicles } from "../../application/get-stopped-vehicles.js";
import type { ToolCallRecord, UserContext } from "../../application/ports.js";
import { TOOL_NAMES } from "../../application/tool-names.js";
import { UNAVAILABLE_MESSAGES, type ToolResult } from "../../application/tool-result.js";

/**
 * Herramientas del agente (regla 10 de CLAUDE.md). Cada una es una consulta PREDEFINIDA, de solo lectura, con esquema zod y límites:
 * el LLM elige cuál usar y con qué valores, nunca construye una consulta (no hay text-to-SQL).
 *
 * **Ninguna recibe `tenantId`, cookie ni identidad como argumento.** Los esquemas de abajo son lo único que el LLM rellena. La sesión
 * (`UserContext`, verificada por el servidor) entra por la clausura de `createFleetTools`, que se arma por petición, y es lo que
 * fleet-api usa para filtrar por tenant. Este archivo solo traduce: valida la entrada (zod), llama al caso de uso y serializa el resultado.
 */


export const STOPPED_VEHICLES_TOOL_DEFAULTS = { minMinutes: 20, limit: 20 } as const;

export const stoppedVehiclesToolSchema = z.object({
  minMinutes: z
    .number()
    .int()
    .min(1)
    .max(1_440)
    .default(STOPPED_VEHICLES_TOOL_DEFAULTS.minMinutes)
    .describe("Mínimo de minutos que debe llevar detenido el vehículo (1 a 1440). Por defecto 20."),
  zoneKind: z.enum(ZONE_KINDS).optional().describe("Solo los detenidos en una zona de este tipo: critical, depot o customer. Sin él, todos."),
  limit: z.number().int().min(1).max(50).default(STOPPED_VEHICLES_TOOL_DEFAULTS.limit).describe("Máximo de vehículos a listar (1 a 50). Por defecto 20."),
});

export const fleetSummaryToolSchema = z.object({});

export const activeAlertsToolSchema = z.object({
  limit: z.number().int().min(1).max(50).default(20).describe("Máximo de alertas a listar (1 a 50). Por defecto 20."),
});

export interface FleetToolDependencies {
  getStoppedVehicles: GetStoppedVehicles;
  getFleetSummary: GetFleetSummary;
  getActiveAlerts: GetActiveAlerts;
  /** Sesión verificada del usuario que pregunta. La inyecta el servidor; el LLM no la ve. */
  context: UserContext;
  /** Recibe cada herramienta que se ejecutó, para devolverla en la respuesta del chat. */
  record: (call: ToolCallRecord) => void;
  /** Recibe el error inesperado de una herramienta (no el de fleet-api, que viene como resultado) para registrarlo. No debe loguear el mensaje. */
  onError: (toolName: string, error: unknown) => void;
}

const jsonRecord = z.record(z.string(), z.json());

/** Argumentos validados como JSON para la respuesta del chat, sin los opcionales ausentes. Solo lo que el LLM envió: nunca la sesión. */
function inputRecord(input: Readonly<Record<string, unknown>>): Record<string, z.infer<typeof jsonRecord>[string]> {
  return jsonRecord.parse(Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)));
}

/** Resultado cuando la herramienta falla por algo que no es fleet-api. Es un fallo, no datos: el modelo debe decirlo. */
const TOOL_FAILURE: ToolResult<never> = { status: "unavailable", reason: "upstream_error", message: UNAVAILABLE_MESSAGES.upstream_error };

export function createFleetTools(deps: FleetToolDependencies) {
  /** Ejecuta la consulta, la registra (nombre, entrada, estado y duración) y devuelve al modelo el JSON del resultado. */
  async function run(name: string, input: Readonly<Record<string, unknown>>, query: () => Promise<ToolResult<unknown>>): Promise<string> {
    const startedAt = performance.now();
    let result: ToolResult<unknown>;
    try {
      result = await query();
    } catch (error) {
      // Una herramienta no lanza al modelo: devuelve el fallo como resultado, para que el agente lo diga en vez de inventar. El error no se
      // traga: se registra (solo su tipo).
      deps.onError(name, error);
      result = TOOL_FAILURE;
    }
    deps.record({
      name,
      input: inputRecord(input),
      status: result.status === "ok" ? "ok" : "error",
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    });
    return JSON.stringify(result);
  }

  const getStoppedVehicles = tool((input) => run(TOOL_NAMES.stoppedVehicles, input, () => deps.getStoppedVehicles(deps.context, input)), {
    name: TOOL_NAMES.stoppedVehicles,
    description:
      "Lista los vehículos de la flota del usuario que llevan detenidos al menos `minMinutes` minutos, opcionalmente solo en zonas de un tipo " +
      "(por ejemplo `critical` para zonas críticas). Devuelve placa, minutos detenido y la zona. Solo lectura.",
    schema: stoppedVehiclesToolSchema,
  });

  const getFleetSummary = tool((input) => run(TOOL_NAMES.fleetSummary, input, () => deps.getFleetSummary(deps.context)), {
    name: TOOL_NAMES.fleetSummary,
    description: "Resumen de la flota del usuario: total de vehículos, en movimiento, detenidos, sin señal y alertas activas. Solo lectura.",
    schema: fleetSummaryToolSchema,
  });

  const getActiveAlerts = tool((input) => run(TOOL_NAMES.activeAlerts, input, () => deps.getActiveAlerts(deps.context, input)), {
    name: TOOL_NAMES.activeAlerts,
    description: "Lista las alertas activas (sin resolver) de la flota del usuario, de la más reciente a la más antigua. Solo lectura.",
    schema: activeAlertsToolSchema,
  });

  return [getStoppedVehicles, getFleetSummary, getActiveAlerts] as const;
}
