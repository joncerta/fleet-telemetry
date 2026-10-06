import { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage } from "@langchain/core/messages";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFleetTools } from "../interfaces/agent/tools.js";
import { makeFleet } from "../testing/fakes.js";
import { createGetActiveAlerts } from "../application/get-active-alerts.js";
import { createGetFleetSummary } from "../application/get-fleet-summary.js";
import { createGetStoppedVehicles } from "../application/get-stopped-vehicles.js";
import { CONTEXT } from "../testing/fakes.js";
import { MODEL_MAX_RETRIES } from "../domain/model-limits.js";
import { createChatModel, createProviderModel } from "./chat-model.js";

const BREAKER = { errorThresholdPercentage: 50, volumeThreshold: 5, resetTimeoutMs: 15_000, rollingWindowMs: 10_000 };
const SETTINGS = { provider: "anthropic", model: "claude-test", apiKey: "test", callTimeoutMs: 5_000, maxConcurrency: 2, breaker: BREAKER } as const;

const overloaded = () => new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "x" } }), { status: 529, headers: { "content-type": "application/json" } });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createProviderModel (Anthropic)", () => {
  it("lleva el timeout por llamada en las opciones del cliente", () => {
    const model = createProviderModel({ ...SETTINGS, fetch: vi.fn<typeof fetch>() });

    expect(model).toBeInstanceOf(ChatAnthropic);
    expect(model instanceof ChatAnthropic ? model.clientOptions.timeout : undefined).toBe(5_000);
  });

  describe("header anthropic-workspace-id", () => {
    const okResponse = () =>
      new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-test",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const sentHeader = async (workspaceId: string | undefined): Promise<string | null> => {
      let header: string | null = null;
      const fetchMock = vi.fn<typeof fetch>((_input, init) => {
        header = new Headers(init?.headers).get("anthropic-workspace-id");
        return Promise.resolve(okResponse());
      });
      await createProviderModel({ ...SETTINGS, workspaceId, fetch: fetchMock }).invoke([new HumanMessage("hola")]);
      return header;
    };

    it("con workspace la petición lleva el header con su valor (y se conserva el timeout)", async () => {
      expect(await sentHeader("wrkspc_abc123")).toBe("wrkspc_abc123");
      const model = createProviderModel({ ...SETTINGS, workspaceId: "wrkspc_abc123", fetch: vi.fn<typeof fetch>() });
      expect(model instanceof ChatAnthropic ? model.clientOptions.timeout : undefined).toBe(5_000);
    });

    it("sin workspace (ausente o vacío) no envía el header", async () => {
      expect(await sentHeader(undefined)).toBeNull();
      expect(await sentHeader("")).toBeNull();
    });
  });

  it("reintenta UNA vez (no las 6 de LangChain por defecto) ante un 529", async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(overloaded()));
    const model = createProviderModel({ ...SETTINGS, fetch: fetchMock });

    const outcome = model.invoke([new HumanMessage("hola")]).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(120_000);
    await outcome;

    expect(MODEL_MAX_RETRIES).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(MODEL_MAX_RETRIES + 1);
  });
});

describe("createChatModel", () => {
  it("el proveedor real queda detrás del breaker, que arranca cerrado", () => {
    const model = createChatModel({ ...SETTINGS, fetch: vi.fn<typeof fetch>() });

    expect(model.breakerState()).toBe("closed");
    model.shutdown();
  });

  it("el proveedor con guion también pasa por el breaker y no necesita API key", () => {
    const model = createChatModel({ ...SETTINGS, provider: "scripted", apiKey: undefined });

    expect(model.breakerState()).toBe("closed");
    model.shutdown();
  });

  it("sin API key con el proveedor real falla al crearlo", () => {
    expect(() => createChatModel({ ...SETTINGS, apiKey: "" })).toThrow(/API key/);
  });
});

describe("deadline de la llamada (con el ChatAnthropic real)", () => {
  it("un 429 con retry-after: 60 NO deja un reintento huérfano: al vencer el deadline fetch se llamó una sola vez", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      () =>
        Promise.resolve(
          new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "x" } }), {
            status: 429,
            headers: { "content-type": "application/json", "retry-after": "60" },
          }),
        ),
    );
    const model = createChatModel({ ...SETTINGS, fetch: fetchMock });
    try {
      const outcome = model.invoke([new HumanMessage("hola")]).catch((error: unknown) => error);

      // Deadline = 5000 × 2 + 5000 = 15000 ms: vence mientras el cliente dormiría los 60 s del retry-after.
      await vi.advanceTimersByTimeAsync(15_001);
      await outcome;
      await vi.advanceTimersByTimeAsync(120_000);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      model.shutdown();
    }
  });
});

describe("herramientas hacia Anthropic", () => {
  const useCases = (() => {
    const fleet = makeFleet();
    return {
      getStoppedVehicles: createGetStoppedVehicles({ fleet }),
      getFleetSummary: createGetFleetSummary({ fleet }),
      getActiveAlerts: createGetActiveAlerts({ fleet }),
    };
  })();
  const tools = createFleetTools({ ...useCases, context: CONTEXT, record: () => undefined, onError: () => undefined });

  it("el cuerpo REAL de la petición lleva las tres herramientas y nada de tenant, cookie, session ni user (modelo detrás del breaker)", async () => {
    let body = "";
    const fetchMock = vi.fn<typeof fetch>((_input, init) => {
      body = typeof init?.body === "string" ? init.body : "";
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-test",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    });
    const model = createChatModel({ ...SETTINGS, fetch: fetchMock });
    try {
      const answer = await model.bindTools([...tools]).invoke([new HumanMessage("hola")]);

      expect(answer.text).toBe("ok");
      const sent: unknown = JSON.parse(body);
      const sentTools = typeof sent === "object" && sent !== null && "tools" in sent && Array.isArray(sent.tools) ? sent.tools : [];
      expect(sentTools).toHaveLength(3);
      expect(JSON.stringify(sentTools)).not.toMatch(/tenant|cookie|session|user/i);
    } finally {
      model.shutdown();
    }
  });

  it("la conversión REAL de ChatAnthropic produce las tres herramientas y su JSON no menciona tenant, cookie, session ni user", () => {
    const anthropic = new ChatAnthropic({ model: "claude-test", apiKey: "test" });

    const formatted = anthropic.formatStructuredToolToAnthropic([...tools]);

    expect(formatted).toHaveLength(3);
    expect(formatted?.map((entry) => ("name" in entry ? entry.name : undefined)).sort()).toEqual(tools.map((entry) => entry.name).sort());
    expect(JSON.stringify(formatted)).not.toMatch(/tenant|cookie|session|user/i);
  });
});
