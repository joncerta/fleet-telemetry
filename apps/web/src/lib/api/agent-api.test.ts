import { CHAT_MESSAGE_MAX_LENGTH } from "@fleet/contracts";
import { describe, expect, it, vi } from "vitest";
import { agentHealth, chatResponse } from "../../test-support/agent-fixtures";
import { bodyOf, jsonResponse } from "../../test-support/fake-fetch";
import { AGENT_API_PATHS, createAgentApi, InvalidChatMessageError } from "./agent-api";
import { ApiRequestError, createHttpClient, UnauthorizedError, type FetchLike } from "./http-client";

const BASE = "http://localhost:4003";

function setup(respond: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = vi.fn<FetchLike>((url, init) => {
    calls.push({ url, init });
    return Promise.resolve(respond(url, init));
  });
  const onUnauthorized = vi.fn();
  const api = createAgentApi(createHttpClient({ baseUrl: BASE, fetch }), onUnauthorized);
  return { api, calls, fetch, onUnauthorized };
}

const apiError = (status: number, code: string, headers: Record<string, string> = {}) =>
  jsonResponse(status, { error: { code, message: "Mensaje técnico del servidor." } }, headers);

describe("agent-api", () => {
  it("POST /v1/chat con la cookie (credentials: include) y solo { message }: nunca tenantId ni identidad", async () => {
    const { api, calls } = setup(() => jsonResponse(200, chatResponse()));
    await expect(api.ask("¿Qué vehículos están detenidos?")).resolves.toEqual(chatResponse());

    expect(calls[0]?.url).toBe(`${BASE}${AGENT_API_PATHS.chat}`);
    expect(calls[0]?.init).toMatchObject({ method: "POST", credentials: "include", headers: { "content-type": "application/json" } });
    expect(bodyOf(calls[0]?.init)).toEqual({ message: "¿Qué vehículos están detenidos?" });
  });

  it("una pregunta que no cumple chatRequestSchema no se envía", async () => {
    const { api, fetch } = setup(() => jsonResponse(200, chatResponse()));
    await expect(api.ask("")).rejects.toBeInstanceOf(InvalidChatMessageError);
    await expect(api.ask("x".repeat(CHAT_MESSAGE_MAX_LENGTH + 1))).rejects.toBeInstanceOf(InvalidChatMessageError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("lee con la variante tolerante: un estado de breaker o de herramienta nuevo llega como 'unknown'", async () => {
    const { api } = setup(() =>
      jsonResponse(200, { ...chatResponse(), breaker: { state: "forcedOpen" }, toolCalls: [{ name: "x", input: {}, status: "skipped", durationMs: 1 }] }),
    );
    const response = await api.ask("hola");
    expect(response.breaker.state).toBe("unknown");
    expect(response.toolCalls[0]?.status).toBe("unknown");
  });

  it("un 401 lleva a 'sin sesión' y se lanza", async () => {
    const { api, onUnauthorized } = setup(() => apiError(401, "unauthorized"));
    await expect(api.ask("hola")).rejects.toBeInstanceOf(UnauthorizedError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("los errores del agente conservan estado, código y Retry-After (429, 503, 504)", async () => {
    const cases = [
      { response: apiError(429, "rate_limited", { "retry-after": "42" }), expected: { status: 429, code: "rate_limited", retryAfterSeconds: 42 } },
      { response: apiError(503, "agent_unavailable"), expected: { status: 503, code: "agent_unavailable" } },
      { response: apiError(504, "agent_timeout"), expected: { status: 504, code: "agent_timeout" } },
    ];
    for (const { response, expected } of cases) {
      const { api } = setup(() => response);
      const error: unknown = await api.ask("hola").catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ApiRequestError);
      expect(error).toMatchObject(expected);
    }
  });

  it("GET /health lee el breaker también con el 503 de un agente degradado", async () => {
    const open = setup(() => jsonResponse(503, agentHealth("open")));
    await expect(open.api.getHealth()).resolves.toMatchObject({ dependencies: { fleetApi: { breaker: "open" } } });
    expect(open.calls[0]?.url).toBe(`${BASE}${AGENT_API_PATHS.health}`);

    const closed = setup(() => jsonResponse(200, agentHealth("closed")));
    await expect(closed.api.getHealth()).resolves.toMatchObject({ dependencies: { fleetApi: { breaker: "closed" } } });
  });
});
