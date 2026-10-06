import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { ScriptedChatModel } from "./scripted-chat-model.js";

const model = new ScriptedChatModel();
const ask = (text: string) => model.invoke([new HumanMessage(`<pregunta>\n${text}\n</pregunta>`)]);

function answerWith(toolName: string, content: unknown) {
  const call = { type: "tool_call" as const, id: "call-1", name: toolName, args: {} };
  return model.invoke([
    new HumanMessage("<pregunta>\nx\n</pregunta>"),
    new AIMessage({ content: "", tool_calls: [call] }),
    new ToolMessage({ tool_call_id: "call-1", content: typeof content === "string" ? content : JSON.stringify(content) }),
  ]);
}

describe("ScriptedChatModel: qué herramienta pide", () => {
  it("B1: detenidos más de 20 minutos en zonas críticas -> get_stopped_vehicles { minMinutes: 20, zoneKind: critical }", async () => {
    const message = await ask("¿Qué vehículos llevan detenidos más de 20 minutos en zonas críticas?");

    expect(message.tool_calls).toEqual([expect.objectContaining({ name: "get_stopped_vehicles", args: { minMinutes: 20, zoneKind: "critical" } })]);
  });

  it("entiende otros minutos, horas y tipos de zona", async () => {
    expect((await ask("detenidos más de 45 minutos")).tool_calls?.[0]?.args).toEqual({ minMinutes: 45 });
    expect((await ask("detenidos hace más de 2 horas en el depósito")).tool_calls?.[0]?.args).toEqual({ minMinutes: 120, zoneKind: "depot" });
    expect((await ask("detenidos en zona de cliente")).tool_calls?.[0]?.args).toEqual({ minMinutes: 20, zoneKind: "customer" });
  });

  it("resumen y alertas", async () => {
    expect((await ask("dame un resumen")).tool_calls?.[0]?.name).toBe("get_fleet_summary");
    expect((await ask("¿hay alertas?")).tool_calls?.[0]?.name).toBe("get_active_alerts");
  });

  it("una pregunta que no reconoce no pide herramientas y lo dice", async () => {
    const message = await ask("cuéntame un chiste");

    expect(message.tool_calls ?? []).toEqual([]);
    expect(message.text).toMatch(/solo puedo responder/i);
  });
});

describe("ScriptedChatModel: cómo redacta con el resultado de la herramienta", () => {
  it("usa los datos reales de la herramienta", async () => {
    const message = await answerWith("get_stopped_vehicles", {
      status: "ok",
      data: { count: 2, mayHaveMore: true, vehicles: [{ plate: "AAA111", stoppedMinutes: 30, zoneName: "Z1", zoneKind: "critical" }, { plate: "BBB222", stoppedMinutes: 25, zoneName: null, zoneKind: null }] },
    });

    expect(message.text).toContain("AAA111 (30 min, Z1)");
    expect(message.text).toContain("BBB222 (25 min)");
    expect(message.text).toContain("incompleta");
  });

  it("si la herramienta no está disponible, lo dice y no inventa vehículos", async () => {
    const message = await answerWith("get_stopped_vehicles", { status: "unavailable", reason: "breaker_open", message: "fleet-api no disponible (breaker abierto)." });

    expect(message.text).toContain("No hay datos disponibles");
    expect(message.text).toContain("breaker abierto");
    expect(message.text).not.toMatch(/[A-Z]{3}\d{3}/);
  });

  it("un resultado que no puede interpretar lo dice en vez de inventar", async () => {
    expect((await answerWith("get_stopped_vehicles", "esto no es JSON")).text).toMatch(/no pude interpretar/i);
    expect((await answerWith("get_stopped_vehicles", { status: "ok", data: { raro: true } })).text).toMatch(/no pude interpretar/i);
    expect((await answerWith("otra_herramienta", { status: "ok", data: {} })).text).toMatch(/no reconozco/i);
  });
});
