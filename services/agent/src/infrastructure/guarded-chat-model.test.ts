import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createGuardedChatModel, ModelBreakerOpenError, type GuardedChatModel } from "./guarded-chat-model.js";

const SETTINGS = { timeoutMs: 500, errorThresholdPercentage: 50, volumeThreshold: 3, resetTimeoutMs: 1_000, rollingWindowMs: 10_000 };

/** Error como el del SDK de Anthropic: lleva el estado HTTP en `status`. */
class ProviderError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`provider ${status}`);
    this.status = status;
  }
}

/** Modelo de prueba: cada llamada la resuelve `respond`. */
class StubModel extends BaseChatModel {
  calls = 0;
  boundTools: readonly unknown[] | undefined;
  /** El modelo con herramientas enlazadas: un objeto DISTINTO, para detectar que se invoque el modelo sin enlazar. */
  bound: StubModel | undefined;
  respond: (signal: AbortSignal | undefined) => Promise<AIMessage> = () => Promise.resolve(new AIMessage("ok"));

  constructor() {
    super({});
  }

  _llmType(): string {
    return "stub";
  }

  override bindTools(tools: readonly unknown[]): StubModel {
    this.boundTools = tools;
    const bound = new StubModel();
    bound.respond = (signal) => this.respond(signal);
    this.bound = bound;
    return bound;
  }

  async _generate(_messages: BaseMessage[], options: this["ParsedCallOptions"]): Promise<ChatResult> {
    this.calls += 1;
    const message = await this.respond(options.signal);
    return { generations: [{ text: typeof message.content === "string" ? message.content : "", message }] };
  }
}

const made: GuardedChatModel[] = [];

function setup(maxConcurrency = 4) {
  const inner = new StubModel();
  const guarded = createGuardedChatModel({ model: inner, breaker: SETTINGS, maxConcurrency });
  made.push(guarded);
  return { inner, guarded };
}

const ask = (model: { invoke: BaseChatModel["invoke"] }, signal?: AbortSignal) =>
  model.invoke([new HumanMessage("hola")], signal === undefined ? undefined : { signal });

/** Abre el circuito con `times` fallos seguidos (por defecto, el volumen mínimo). */
async function failTimes(model: { invoke: BaseChatModel["invoke"] }, inner: StubModel, error: Error, times = SETTINGS.volumeThreshold) {
  inner.respond = () => Promise.reject(error);
  for (let i = 0; i < times; i += 1) await ask(model).catch(() => undefined);
}

const aTool: StructuredToolInterface = tool(() => "x", { name: "una_herramienta", description: "d", schema: z.object({}) });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const model of made.splice(0)) model.shutdown();
  vi.useRealTimers();
});

describe("createGuardedChatModel", () => {
  it("con el proveedor sano devuelve la respuesta del modelo y el circuito sigue cerrado", async () => {
    const { guarded } = setup();

    const message = await ask(guarded);

    expect(message.text).toBe("ok");
    expect(guarded.breakerState()).toBe("closed");
  });

  it("conserva usage_metadata de la respuesta del modelo", async () => {
    const { inner, guarded } = setup();
    inner.respond = () => Promise.resolve(new AIMessage({ content: "ok", usage_metadata: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } }));

    const message = await ask(guarded);

    expect(AIMessage.isInstance(message) ? message.usage_metadata : undefined).toEqual({ input_tokens: 10, output_tokens: 4, total_tokens: 14 });
  });

  it("los 5xx abren el circuito y con él abierto NO se llama al modelo", async () => {
    const { inner, guarded } = setup();
    await failTimes(guarded, inner, new ProviderError(529));
    expect(guarded.breakerState()).toBe("open");
    const callsWhenOpened = inner.calls;

    await expect(ask(guarded)).rejects.toBeInstanceOf(ModelBreakerOpenError);

    expect(inner.calls).toBe(callsWhenOpened);
  });

  it("un modelo que no responde a tiempo cuenta como fallo y abre el circuito", async () => {
    const { inner, guarded } = setup();
    inner.respond = () => new Promise<AIMessage>(() => undefined);
    const pending = Array.from({ length: SETTINGS.volumeThreshold }, () => ask(guarded).catch((error: unknown) => error));

    await vi.advanceTimersByTimeAsync(SETTINGS.timeoutMs + 1);
    await Promise.all(pending);

    expect(guarded.breakerState()).toBe("open");
  });

  it("los 4xx del proveedor (clave inválida, petición mala) NO abren el circuito", async () => {
    const { inner, guarded } = setup();

    await failTimes(guarded, inner, new ProviderError(400), SETTINGS.volumeThreshold * 3);

    expect(guarded.breakerState()).toBe("closed");
    await expect(ask(guarded)).rejects.toBeInstanceOf(ProviderError);
  });

  it("un 429 del proveedor (saturación) SÍ cuenta como fallo", async () => {
    const { inner, guarded } = setup();

    await failTimes(guarded, inner, new ProviderError(429));

    expect(guarded.breakerState()).toBe("open");
  });

  it("si el cliente cancela (signal abortado) el fallo no abre el circuito", async () => {
    const { inner, guarded } = setup();
    const controller = new AbortController();
    controller.abort();
    inner.respond = () => Promise.reject(new DOMException("aborted", "AbortError"));

    for (let i = 0; i < SETTINGS.volumeThreshold * 2; i += 1) await ask(guarded, controller.signal).catch(() => undefined);

    expect(guarded.breakerState()).toBe("closed");
  });

  it("pasa a halfOpen tras resetTimeout y un éxito lo cierra", async () => {
    const { inner, guarded } = setup();
    await failTimes(guarded, inner, new ProviderError(503));
    await vi.advanceTimersByTimeAsync(SETTINGS.resetTimeoutMs + 1);
    expect(guarded.breakerState()).toBe("halfOpen");
    inner.respond = () => Promise.resolve(new AIMessage("de vuelta"));

    const message = await ask(guarded);

    expect(message.text).toBe("de vuelta");
    expect(guarded.breakerState()).toBe("closed");
  });

  it("si la prueba en halfOpen falla, vuelve a abrir", async () => {
    const { inner, guarded } = setup();
    await failTimes(guarded, inner, new ProviderError(503));
    await vi.advanceTimersByTimeAsync(SETTINGS.resetTimeoutMs + 1);
    expect(guarded.breakerState()).toBe("halfOpen");

    await ask(guarded).catch(() => undefined);

    expect(guarded.breakerState()).toBe("open");
  });

  it("bindTools enlaza las herramientas en el modelo real y devuelve un modelo protegido por el MISMO breaker", async () => {
    const { inner, guarded } = setup();

    const bound = guarded.bindTools([aTool]);
    expect(inner.boundTools).toEqual([aTool]);
    await failTimes(bound, inner, new ProviderError(500));
    // Las llamadas del modelo enlazado van al objeto enlazado, nunca al modelo sin herramientas.
    expect(inner.bound?.calls).toBe(SETTINGS.volumeThreshold);
    expect(inner.calls).toBe(0);

    expect(guarded.breakerState()).toBe("open");
    await expect(ask(guarded)).rejects.toBeInstanceOf(ModelBreakerOpenError);
  });

  it("el deadline vive DENTRO de la acción: vence, ABORTA la llamada interna (no deja un reintento huérfano) y cuenta como fallo", async () => {
    const { inner, guarded } = setup();
    let seen: AbortSignal | undefined;
    inner.respond = (signal) => {
      seen = signal;
      return new Promise<AIMessage>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("abortada"))));
    };
    const calls = Array.from({ length: SETTINGS.volumeThreshold }, () => ask(guarded).catch((error: unknown) => error));

    await vi.advanceTimersByTimeAsync(SETTINGS.timeoutMs + 1);
    await Promise.all(calls);

    expect(seen?.aborted).toBe(true);
    expect(guarded.breakerState()).toBe("open");
  });

  it("la espera por un cupo NO cuenta para el circuito: con 1 cupo y dos llamadas de 0,7 × timeout, sigue closed y la segunda responde", async () => {
    const { inner, guarded } = setup(1);
    inner.respond = () => new Promise<AIMessage>((resolve) => setTimeout(() => resolve(new AIMessage("ok")), SETTINGS.timeoutMs * 0.7));

    const both = Promise.all([ask(guarded), ask(guarded)]);
    await vi.advanceTimersByTimeAsync(SETTINGS.timeoutMs * 0.35);
    expect(inner.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(SETTINGS.timeoutMs * 1.1);
    const [first, second] = await both;

    expect(first.text).toBe("ok");
    expect(second.text).toBe("ok");
    expect(guarded.breakerState()).toBe("closed");
  });

  it("nunca hay más llamadas simultáneas al proveedor que cupos", async () => {
    const { inner, guarded } = setup(2);
    let inFlight = 0;
    let peak = 0;
    inner.respond = () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      return new Promise<AIMessage>((resolve) =>
        setTimeout(() => {
          inFlight -= 1;
          resolve(new AIMessage("ok"));
        }, 100),
      );
    };

    const all = Promise.all(Array.from({ length: 5 }, () => ask(guarded)));
    await vi.advanceTimersByTimeAsync(1_000);
    await all;

    expect(peak).toBe(2);
    expect(inner.calls).toBe(5);
  });

  it("la señal de la pregunta acota la espera en cola: cancelar saca al que espera sin llamar al modelo y el cupo no se pierde", async () => {
    const { inner, guarded } = setup(1);
    inner.respond = () => new Promise<AIMessage>((resolve) => setTimeout(() => resolve(new AIMessage("ok")), 100));
    const running = ask(guarded);
    const controller = new AbortController();
    const waiting = ask(guarded, controller.signal).catch((error: unknown) => error);

    controller.abort();
    await waiting;
    await vi.advanceTimersByTimeAsync(101);
    await running;
    const again = ask(guarded);
    await vi.advanceTimersByTimeAsync(101);

    expect((await again).text).toBe("ok");
    expect(inner.calls).toBe(2);
    expect(guarded.breakerState()).toBe("closed");
  });

  it("en halfOpen, una prueba cancelada por el llamador NO cierra el circuito: queda open", async () => {
    const { inner, guarded } = setup();
    await failTimes(guarded, inner, new ProviderError(503));
    await vi.advanceTimersByTimeAsync(SETTINGS.resetTimeoutMs + 1);
    expect(guarded.breakerState()).toBe("halfOpen");
    const controller = new AbortController();
    inner.respond = (signal) => new Promise<AIMessage>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("abortada"))));

    const probe = ask(guarded, controller.signal).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await probe;

    expect(guarded.breakerState()).toBe("open");
  });
});
