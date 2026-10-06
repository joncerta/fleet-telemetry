import { describe, expect, it } from "vitest";
import {
  agentHealthResponseSchema,
  agentHealthResponseTolerantSchema,
  CHAT_MESSAGE_MAX_LENGTH,
  chatRequestSchema,
  chatResponseSchema,
  chatResponseTolerantSchema,
} from "./agent.js";

const toolCall = { name: "get_fleet_summary", input: {}, status: "ok", durationMs: 3 };
const response = { answer: "Hay 3 vehículos.", toolCalls: [toolCall], breaker: { state: "closed" } };

describe("chatRequestSchema", () => {
  it("acepta de 1 a 2000 caracteres y rechaza vacío, más largo, otro tipo y la ausencia del mensaje", () => {
    expect(chatRequestSchema.safeParse({ message: "a" }).success).toBe(true);
    expect(chatRequestSchema.safeParse({ message: "a".repeat(CHAT_MESSAGE_MAX_LENGTH) }).success).toBe(true);
    expect(chatRequestSchema.safeParse({ message: "" }).success).toBe(false);
    expect(chatRequestSchema.safeParse({ message: "a".repeat(CHAT_MESSAGE_MAX_LENGTH + 1) }).success).toBe(false);
    expect(chatRequestSchema.safeParse({ message: 7 }).success).toBe(false);
    expect(chatRequestSchema.safeParse({}).success).toBe(false);
  });

  it("descarta un tenantId que mande el cliente: el tenant sale solo de la sesión", () => {
    const parsed = chatRequestSchema.parse({ message: "hola", tenantId: "00000000-0000-4000-8000-000000000001" });

    expect(parsed).toEqual({ message: "hola" });
  });
});

describe("chatResponseSchema", () => {
  it("acepta los tres estados del breaker y los dos de una herramienta", () => {
    for (const state of ["closed", "open", "halfOpen"]) {
      expect(chatResponseSchema.safeParse({ ...response, breaker: { state } }).success).toBe(true);
    }
    expect(chatResponseSchema.safeParse({ ...response, toolCalls: [{ ...toolCall, status: "error" }] }).success).toBe(true);
  });

  it("rechaza un estado desconocido, una duración negativa o fraccionaria y la ausencia de campos", () => {
    expect(chatResponseSchema.safeParse({ ...response, breaker: { state: "broken" } }).success).toBe(false);
    expect(chatResponseSchema.safeParse({ ...response, toolCalls: [{ ...toolCall, status: "pending" }] }).success).toBe(false);
    expect(chatResponseSchema.safeParse({ ...response, toolCalls: [{ ...toolCall, durationMs: -1 }] }).success).toBe(false);
    expect(chatResponseSchema.safeParse({ ...response, toolCalls: [{ ...toolCall, durationMs: 1.5 }] }).success).toBe(false);
    expect(chatResponseSchema.safeParse({ answer: "x", toolCalls: [] }).success).toBe(false);
  });

  it("la variante tolerante lee un estado desconocido como unknown", () => {
    const parsed = chatResponseTolerantSchema.parse({ ...response, breaker: { state: "forced" }, toolCalls: [{ ...toolCall, status: "timeout" }] });

    expect(parsed.breaker.state).toBe("unknown");
    expect(parsed.toolCalls[0]?.status).toBe("unknown");
  });
});

describe("agentHealthResponseSchema", () => {
  const health = { status: "ok", checks: { fleetApi: "up" }, dependencies: { fleetApi: { breaker: "closed" } } };

  it("es el health común más el breaker de fleet-api", () => {
    expect(agentHealthResponseSchema.safeParse(health).success).toBe(true);
    expect(agentHealthResponseSchema.safeParse({ status: "ok", checks: {} }).success).toBe(false);
    expect(agentHealthResponseSchema.safeParse({ ...health, dependencies: { fleetApi: { breaker: "x" } } }).success).toBe(false);
  });

  it("la variante tolerante lee un breaker desconocido como unknown", () => {
    const parsed = agentHealthResponseTolerantSchema.parse({ ...health, dependencies: { fleetApi: { breaker: "x" } } });

    expect(parsed.dependencies.fleetApi.breaker).toBe("unknown");
  });

  it("incluye el breaker del proveedor del modelo (aditivo: un agente anterior que no lo envía sigue parseando)", () => {
    const withModel = { ...health, dependencies: { fleetApi: { breaker: "closed" }, model: { breaker: "halfOpen" } } };

    expect(agentHealthResponseSchema.parse(withModel).dependencies.model?.breaker).toBe("halfOpen");
    expect(agentHealthResponseSchema.safeParse({ ...health, dependencies: { fleetApi: { breaker: "closed" }, model: { breaker: "x" } } }).success).toBe(false);
    expect(agentHealthResponseTolerantSchema.parse({ ...withModel, dependencies: { ...withModel.dependencies, model: { breaker: "x" } } }).dependencies.model?.breaker).toBe("unknown");
    // Mensaje de la versión anterior (sin `model`).
    expect(agentHealthResponseSchema.parse(health).dependencies.model).toBeUndefined();
  });
});
