import { describe, expect, it, vi } from "vitest";
import { createAgentApi } from "../../lib/api/agent-api";
import { createHttpClient } from "../../lib/api/http-client";
import { agentHealth, chatResponse } from "../../test-support/agent-fixtures";
import { bodyOf, controllableFetch, jsonResponse } from "../../test-support/fake-fetch";
import { createChatController } from "./chat-controller";

function setup() {
  const fake = controllableFetch();
  const onUnauthorized = vi.fn();
  const api = createAgentApi(createHttpClient({ baseUrl: "http://agent.test", fetch: fake.fetch }), onUnauthorized);
  const controller = createChatController(api);
  return { fake, controller, onUnauthorized, state: () => controller.store.getState() };
}

/** Deja correr las promesas pendientes (respuestas del fetch falso). */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createChatController", () => {
  it("escribiendo → respuesta, con el breaker de la respuesta", async () => {
    const { fake, controller, state } = setup();
    const asking = controller.ask("  ¿Qué vehículos están detenidos?  ");
    expect(state()).toMatchObject({ status: "sending", question: "¿Qué vehículos están detenidos?", response: null });
    expect(bodyOf(fake.last().init)).toEqual({ message: "¿Qué vehículos están detenidos?" });

    fake.last().respond(jsonResponse(200, chatResponse({ breaker: { state: "open" } })));
    await asking;
    expect(state()).toMatchObject({ status: "answered", breaker: "open" });
    expect(state().response?.toolCalls).toHaveLength(1);
  });

  it("enviar otra pregunta cancela la anterior: su respuesta tardía nunca pisa a la nueva", async () => {
    const { fake, controller, state } = setup();
    void controller.ask("primera");
    const first = fake.last();
    void controller.ask("segunda");
    const second = fake.last();

    expect(first.aborted()).toBe(true);
    second.respond(jsonResponse(200, chatResponse({ answer: "respuesta a la segunda" })));
    await flush();
    expect(state()).toMatchObject({ status: "answered", question: "segunda" });
    expect(state().response?.answer).toBe("respuesta a la segunda");
  });

  it("cancelar (cerrar el chat) aborta la petición y vuelve a reposo sin mostrar un error", async () => {
    const { fake, controller, state } = setup();
    void controller.ask("pregunta");
    controller.cancel();
    await flush();
    expect(fake.last().aborted()).toBe(true);
    expect(state()).toMatchObject({ status: "idle", failure: null });
  });

  it("dispose (desmontar) aborta la pregunta y la consulta de salud en curso", () => {
    const { fake, controller } = setup();
    void controller.ask("pregunta");
    void controller.refreshHealth();
    controller.dispose();
    expect(fake.calls.every((call) => call.aborted())).toBe(true);
  });

  it("un error del agente se muestra con reintento, y reintentar repite la misma pregunta", async () => {
    const { fake, controller, state } = setup();
    void controller.ask("¿Cuántos vehículos hay?");
    fake.last().respond(jsonResponse(504, { error: { code: "agent_timeout", message: "x" } }));
    await flush();
    expect(state()).toMatchObject({ status: "failed", failure: { message: "El asistente tardó demasiado en responder. Inténtalo de nuevo.", retryable: true } });

    void controller.retry();
    expect(bodyOf(fake.last().init)).toEqual({ message: "¿Cuántos vehículos hay?" });
    fake.last().respond(jsonResponse(200, chatResponse()));
    await flush();
    expect(state().status).toBe("answered");
  });

  it("el límite de preguntas (429) dice cuánto esperar", async () => {
    const { fake, controller, state } = setup();
    void controller.ask("pregunta");
    fake.last().respond(jsonResponse(429, { error: { code: "rate_limited", message: "x" } }, { "retry-after": "30" }));
    await flush();
    expect(state().failure).toMatchObject({ rateLimited: true, message: "Alcanzaste el límite de preguntas. Inténtalo de nuevo en 30 s." });
  });

  it("503 agent_unavailable y sin conexión son errores con reintento", async () => {
    const { fake, controller, state } = setup();
    void controller.ask("pregunta");
    fake.last().respond(jsonResponse(503, { error: { code: "agent_unavailable", message: "x" } }));
    await flush();
    expect(state().failure?.message).toBe("El asistente no está disponible en este momento. Inténtalo de nuevo.");

    void controller.ask("pregunta");
    fake.last().fail(new TypeError("Failed to fetch"));
    await flush();
    expect(state().failure).toMatchObject({ retryable: true, message: expect.stringContaining("No se pudo conectar con el asistente") as unknown });
  });

  it("un 401 cierra la sesión y no ofrece reintento", async () => {
    const { fake, controller, state, onUnauthorized } = setup();
    void controller.ask("pregunta");
    fake.last().respond(jsonResponse(401, { error: { code: "unauthorized", message: "x" } }));
    await flush();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(state().failure?.retryable).toBe(false);
    void controller.retry();
    expect(fake.calls).toHaveLength(1);
  });

  it("al abrir, /health trae el breaker (también con el 503); si /health falla, no inventa un estado", async () => {
    const { fake, controller, state } = setup();
    void controller.refreshHealth();
    fake.last().respond(jsonResponse(503, agentHealth("open")));
    await flush();
    expect(state().breaker).toBe("open");

    void controller.refreshHealth();
    fake.last().fail(new TypeError("Failed to fetch"));
    await flush();
    expect(state().breaker).toBe("open");
  });
});
