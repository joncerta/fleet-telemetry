import { randomUUID } from "node:crypto";
import type { ZoneKind } from "@fleet/contracts";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { z } from "zod";
import { toolResultSchema } from "../application/tool-result.js";
import { TOOL_NAMES } from "../application/tool-names.js";

/**
 * Modelo "con guion" (`AGENT_MODEL_PROVIDER=scripted`) para los tests y el e2e: determinista, sin red ni API key.
 *
 * NO es un atajo del agente: es un chat model de LangChain más, y recorre el mismo camino que Claude (`createAgent`, herramientas,
 * cliente resiliente, fleet-api). Solo cambia quién decide:
 * - ante una pregunta que reconoce (vehículos detenidos, resumen, alertas) pide la herramienta que corresponde, con argumentos;
 * - con el resultado REAL de la herramienta delante, redacta la respuesta a partir de él. Si la herramienta falló, lo dice; no
 *   inventa datos. Es la misma regla que el system prompt le impone al modelo real.
 * - ante una pregunta que no reconoce, responde que solo sabe de esos temas.
 */

const DEFAULT_MIN_MINUTES = 20;

/** Minúsculas y sin tildes, para reconocer la pregunta sin depender de cómo se escriba. */
const normalize = (text: string): string => text.normalize("NFD").replaceAll(/\p{M}/gu, "").toLowerCase();

/** La pregunta, sin el delimitador `<pregunta>` con el que el agente la entrega al modelo. */
function questionOf(messages: readonly BaseMessage[]): string {
  const human = messages.findLast((message) => HumanMessage.isInstance(message));
  const content = human === undefined ? "" : typeof human.content === "string" ? human.content : "";
  return content.replaceAll(/<\/?pregunta>/gi, "").trim();
}

function zoneKindOf(question: string): ZoneKind | undefined {
  if (/critic/.test(question)) return "critical";
  if (/deposito/.test(question)) return "depot";
  if (/cliente/.test(question)) return "customer";
  return undefined;
}

function minutesOf(question: string): number {
  const match = /(\d{1,4})\s*(?:min|hora)/.exec(question);
  if (match?.[1] === undefined) return DEFAULT_MIN_MINUTES;
  const value = Number(match[1]) * (match[0].includes("hora") ? 60 : 1);
  return Math.min(1_440, Math.max(1, value));
}

interface PlannedCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

/** La herramienta que pide el modelo ante la pregunta, o `undefined` si no la reconoce. */
function planOf(rawQuestion: string): PlannedCall | undefined {
  const question = normalize(rawQuestion);
  if (/detenid|parad|quiet/.test(question)) {
    const zoneKind = zoneKindOf(question);
    return { name: TOOL_NAMES.stoppedVehicles, args: { minMinutes: minutesOf(question), ...(zoneKind !== undefined && { zoneKind }) } };
  }
  if (/alerta/.test(question)) return { name: TOOL_NAMES.activeAlerts, args: {} };
  if (/resumen|cuantos vehiculos|estado de la flota/.test(question)) return { name: TOOL_NAMES.fleetSummary, args: {} };
  return undefined;
}

const stoppedView = z.object({
  count: z.number(),
  mayHaveMore: z.boolean(),
  vehicles: z.array(z.object({ plate: z.string(), stoppedMinutes: z.number(), zoneName: z.string().nullable(), zoneKind: z.string().nullable() })),
});
const summaryView = z.object({ total: z.number(), moving: z.number(), stopped: z.number(), noSignal: z.number(), activeAlerts: z.number() });
const alertsView = z.object({
  count: z.number(),
  mayHaveMore: z.boolean(),
  alerts: z.array(z.object({ plate: z.string(), type: z.string(), zoneName: z.string().nullable(), startedAt: z.string() })),
});

const plural = (count: number, one: string, many: string): string => (count === 1 ? one : many);

/** Redacta, solo con lo que devolvió una herramienta, la respuesta de esa herramienta. */
function describeResult(toolName: string, content: string): string {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return "La herramienta devolvió una respuesta que no pude interpretar, así que no tengo datos para informar.";
  }
  const result = toolResultSchema.safeParse(json);
  if (!result.success) return "La herramienta devolvió una respuesta que no pude interpretar, así que no tengo datos para informar.";
  if (result.data.status !== "ok") {
    return `No hay datos disponibles en este momento: ${result.data.message} No puedo informar vehículos ni cifras sin esa consulta.`;
  }

  if (toolName === TOOL_NAMES.stoppedVehicles) {
    const view = stoppedView.safeParse(result.data.data);
    if (!view.success) return "No pude interpretar el resultado de los vehículos detenidos.";
    if (view.data.count === 0) return "No hay vehículos detenidos que cumplan ese criterio.";
    const list = view.data.vehicles
      .map((vehicle) => `${vehicle.plate} (${vehicle.stoppedMinutes} min${vehicle.zoneName === null ? "" : `, ${vehicle.zoneName}`})`)
      .join("; ");
    const more = view.data.mayHaveMore ? " La lista puede estar incompleta." : "";
    return `Hay ${view.data.count} ${plural(view.data.count, "vehículo detenido", "vehículos detenidos")}: ${list}.${more}`;
  }
  if (toolName === TOOL_NAMES.fleetSummary) {
    const view = summaryView.safeParse(result.data.data);
    if (!view.success) return "No pude interpretar el resumen de la flota.";
    const { total, moving, stopped, noSignal, activeAlerts } = view.data;
    return `La flota tiene ${total} vehículos: ${moving} en movimiento, ${stopped} detenidos y ${noSignal} sin señal. Hay ${activeAlerts} alertas activas.`;
  }
  if (toolName === TOOL_NAMES.activeAlerts) {
    const view = alertsView.safeParse(result.data.data);
    if (!view.success) return "No pude interpretar las alertas.";
    if (view.data.count === 0) return "No hay alertas activas.";
    const list = view.data.alerts.map((alert) => `${alert.plate} (${alert.type}${alert.zoneName === null ? "" : `, ${alert.zoneName}`})`).join("; ");
    return `Hay ${view.data.count} ${plural(view.data.count, "alerta activa", "alertas activas")}: ${list}.`;
  }
  return "No reconozco esa herramienta, así que no tengo datos para informar.";
}

/** Resultados de herramientas entregados DESPUÉS de la última pregunta, con el nombre de la herramienta que los produjo. */
function toolResultsSinceQuestion(messages: readonly BaseMessage[]): { name: string; content: string }[] {
  const questionIndex = messages.findLastIndex((message) => HumanMessage.isInstance(message));
  const after = messages.slice(questionIndex + 1);
  const namesById = new Map<string, string>();
  for (const message of after) {
    if (AIMessage.isInstance(message)) for (const call of message.tool_calls ?? []) if (call.id !== undefined) namesById.set(call.id, call.name);
  }
  return after.filter((message) => ToolMessage.isInstance(message)).map((message) => ({
    name: namesById.get(message.tool_call_id) ?? message.name ?? "",
    content: typeof message.content === "string" ? message.content : "",
  }));
}

export class ScriptedChatModel extends BaseChatModel {
  constructor() {
    super({});
  }

  _llmType(): string {
    return "scripted";
  }

  /** Las herramientas ya las conoce el guion: no hay nada que enlazar. */
  override bindTools(): this {
    return this;
  }

  _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const results = toolResultsSinceQuestion(messages);
    let message: AIMessage;

    if (results.length > 0) {
      message = new AIMessage(results.map((result) => describeResult(result.name, result.content)).join("\n"));
    } else {
      const plan = planOf(questionOf(messages));
      message =
        plan === undefined
          ? new AIMessage("Solo puedo responder sobre los vehículos detenidos, el resumen de la flota y las alertas activas.")
          : new AIMessage({ content: "", tool_calls: [{ type: "tool_call", id: randomUUID(), name: plan.name, args: plan.args }] });
    }
    const text = typeof message.content === "string" ? message.content : "";
    return Promise.resolve({ generations: [{ text, message }] });
  }
}

