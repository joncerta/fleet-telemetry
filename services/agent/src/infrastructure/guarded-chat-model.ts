import type { BreakerState } from "@fleet/contracts";
import type { Logger } from "@fleet/platform";
import type { BaseLanguageModelInput } from "@langchain/core/language_models/base";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import CircuitBreaker from "opossum";
import type { BreakerSettings } from "./resilient-fleet-client.js";

/** El circuito hacia el proveedor del modelo está abierto: no se hizo ninguna llamada. */
export class ModelBreakerOpenError extends Error {
  constructor() {
    super("El circuito hacia el proveedor del modelo está abierto.");
    this.name = "ModelBreakerOpenError";
  }
}

/** La llamada al proveedor superó su deadline (intentos y esperas de reintento incluidos). Cuenta como fallo del proveedor. */
class ModelDeadlineError extends Error {
  readonly code = "ETIMEDOUT";

  constructor() {
    super("La llamada al modelo superó su deadline.");
    this.name = "ModelDeadlineError";
  }
}

/** La llamada se canceló desde fuera (el cliente cerró la conexión, o venció el tiempo total de la pregunta): no es un fallo del proveedor. */
class CallerAbortedError extends Error {
  constructor(options: { cause: unknown }) {
    super("La llamada al modelo se canceló desde fuera.", options);
    this.name = "CallerAbortedError";
  }
}

/** Lo único que el guardián necesita del modelo (o del modelo con herramientas enlazadas). */
interface ModelInvoker {
  invoke(input: BaseLanguageModelInput, options?: { signal?: AbortSignal }): Promise<BaseMessage>;
}

type ModelCall = [invoker: ModelInvoker, messages: BaseMessage[], signal: AbortSignal | undefined];

export interface GuardedChatModelOptions {
  /** El chat model real (o el de guion). */
  model: BaseChatModel;
  /**
   * `timeoutMs` es el DEADLINE de la llamada al proveedor (reintentos del cliente y sus esperas incluidos). Corre dentro de la acción, ya
   * con el cupo tomado: la espera en cola no cuenta para el circuito.
   */
  breaker: BreakerSettings;
  /** Llamadas simultáneas al proveedor desde esta réplica. Las demás esperan su cupo FUERA del breaker, acotadas por la señal de la pregunta. */
  maxConcurrency: number;
  logger?: Logger;
}

/** Un chat model con un circuit breaker delante. `breakerState` y `shutdown` son del breaker compartido. */
export interface GuardedChatModel extends BaseChatModel {
  /** Siempre disponible (en `BaseChatModel` es opcional): enlaza las herramientas y sigue detrás del mismo breaker. */
  bindTools: NonNullable<BaseChatModel["bindTools"]>;
  breakerState(): BreakerState;
  shutdown(): void;
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
  return typeof error.status === "number" ? error.status : undefined;
}

function codeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

/**
 * Un 4xx del proveedor (clave inválida, petición mal formada) es un error nuestro o de la cuenta, no una caída: no abre el circuito.
 * Se exceptúan el 408 y el 429 (el proveedor está saturado: es justo lo que el breaker debe frenar). Lo cancelado desde fuera tampoco cuenta,
 * salvo en `halfOpen`: opossum trata un error filtrado como éxito y cerraría el circuito sin que el proveedor haya respondido.
 * (El `GraphRecursionError` no pasa por aquí: lo lanza el grafo del agente, no la llamada al modelo.)
 */
const statusIsClientError = (error: unknown): boolean => {
  const status = statusOf(error);
  return status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429;
};

function reasonOf(error: unknown): string {
  const status = statusOf(error);
  if (status !== undefined) return `http_${status}`;
  if (codeOf(error) === "ETIMEDOUT") return "timeout";
  return error instanceof Error ? error.name : "unknown";
}

const abortError = (): Error => new DOMException("La espera del cupo se canceló.", "AbortError");

/**
 * Semáforo de cupos: tope de llamadas simultáneas al proveedor. La espera es FUERA del breaker (no cuenta para el circuito) y la acota la señal
 * de la pregunta; el cupo pasa directo al siguiente en la cola al liberarse.
 */
class Slots {
  private free: number;
  private readonly waiters: (() => void)[] = [];

  constructor(max: number) {
    this.free = max;
  }

  acquire(signal: AbortSignal | undefined): Promise<() => void> {
    if (signal?.aborted === true) return Promise.reject(abortError());
    if (this.free > 0) {
      this.free -= 1;
      return Promise.resolve(this.releaser());
    }
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        this.waiters.splice(this.waiters.indexOf(grant), 1);
        reject(abortError());
      };
      const grant = (): void => {
        signal?.removeEventListener("abort", onAbort);
        resolve(this.releaser());
      };
      this.waiters.push(grant);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next === undefined) this.free += 1;
      else next();
    };
  }
}

/** Puente entre el chat model y el breaker. Se crea UNA vez; los modelos con herramientas enlazadas comparten el mismo. */
class ModelGuard {
  private readonly breaker: CircuitBreaker<ModelCall, BaseMessage>;
  private readonly slots: Slots;

  constructor(settings: BreakerSettings, maxConcurrency: number, logger: Logger | undefined) {
    this.slots = new Slots(maxConcurrency);
    this.breaker = new CircuitBreaker<ModelCall, BaseMessage>(
      // El deadline vive AQUÍ, con el cupo ya tomado: no cuenta la cola y, al vencer, ABORTA la llamada interna (sin un reintento huérfano que
      // se pague). Se combina con la señal del llamador (la pregunta cancelada). Es un `setTimeout` (y no `AbortSignal.timeout`) para poder
      // probarlo con fake timers.
      async (invoker, messages, callerSignal) => {
        const deadline = new AbortController();
        let timer: NodeJS.Timeout | undefined;
        const expired = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            deadline.abort();
            reject(new ModelDeadlineError());
          }, settings.timeoutMs);
        });
        const signal = callerSignal === undefined ? deadline.signal : AbortSignal.any([deadline.signal, callerSignal]);
        const call = invoker.invoke(messages, { signal });
        // Si el deadline gana, la llamada interna (ya abortada) puede rechazar después: se absorbe para que no sea un rechazo sin manejar.
        call.catch(() => undefined);
        try {
          return await Promise.race([call, expired]);
        } catch (error) {
          if (callerSignal?.aborted === true && !(error instanceof ModelDeadlineError)) throw new CallerAbortedError({ cause: error });
          throw error;
        } finally {
          clearTimeout(timer);
        }
      },
      {
        name: "model",
        // Sin timeout de opossum: el deadline de arriba cuenta solo la llamada, no la espera del cupo.
        timeout: false,
        errorThresholdPercentage: settings.errorThresholdPercentage,
        volumeThreshold: settings.volumeThreshold,
        resetTimeout: settings.resetTimeoutMs,
        rollingCountTimeout: settings.rollingWindowMs,
        // Opossum trata un error filtrado como éxito; en `halfOpen` eso CERRARÍA el circuito sin que el proveedor haya respondido (una pestaña
        // cerrada o el tiempo total de la pregunta). Ahí la cancelación cuenta como fallo y el circuito vuelve a abrir.
        errorFilter: (error: unknown) => (error instanceof CallerAbortedError ? !this.breaker.halfOpen : statusIsClientError(error)),
      },
    );
    // Cada fallo que cuenta para el circuito: el motivo, nunca el mensaje (puede traer la pregunta o la clave).
    this.breaker.on("failure", (error: unknown) => logger?.warn({ dependency: "model", reason: reasonOf(error) }, "Llamada al modelo fallida"));
    this.breaker.on("open", () => logger?.warn({ dependency: "model" }, "Circuit breaker del modelo abierto"));
    this.breaker.on("halfOpen", () => logger?.info({ dependency: "model" }, "Circuit breaker del modelo en halfOpen"));
    this.breaker.on("close", () => logger?.info({ dependency: "model" }, "Circuit breaker del modelo cerrado"));
  }

  async run(invoker: ModelInvoker, messages: BaseMessage[], signal: AbortSignal | undefined): Promise<BaseMessage> {
    // Con el circuito abierto no se hace cola por un cupo: falla al instante.
    if (this.breaker.opened) throw new ModelBreakerOpenError();
    const release = await this.slots.acquire(signal);
    try {
      return await this.breaker.fire(invoker, messages, signal);
    } catch (error) {
      if (codeOf(error) === "EOPENBREAKER") throw new ModelBreakerOpenError();
      if (error instanceof CallerAbortedError) throw error.cause;
      throw error;
    } finally {
      release();
    }
  }

  state(): BreakerState {
    if (this.breaker.opened) return "open";
    if (this.breaker.halfOpen) return "halfOpen";
    return "closed";
  }

  shutdown(): void {
    this.breaker.shutdown();
  }
}

class GuardedChatModelImpl extends BaseChatModel implements GuardedChatModel {
  private readonly guard: ModelGuard;
  private readonly target: BaseChatModel;
  private readonly invoker: ModelInvoker;

  constructor(guard: ModelGuard, target: BaseChatModel, invoker: ModelInvoker) {
    super({});
    this.guard = guard;
    this.target = target;
    this.invoker = invoker;
  }

  _llmType(): string {
    return "guarded";
  }

  breakerState(): BreakerState {
    return this.guard.state();
  }

  shutdown(): void {
    this.guard.shutdown();
  }

  /** Las herramientas se enlazan en el modelo real (su formato es el del proveedor) y el resultado sigue detrás del MISMO breaker. */
  override bindTools(...args: Parameters<NonNullable<BaseChatModel["bindTools"]>>): GuardedChatModelImpl {
    if (this.target.bindTools === undefined) throw new Error("El modelo no admite herramientas.");
    return new GuardedChatModelImpl(this.guard, this.target, this.target.bindTools(...args));
  }

  async _generate(messages: BaseMessage[], options: this["ParsedCallOptions"]): Promise<ChatResult> {
    const message = await this.guard.run(this.invoker, messages, options.signal);
    return { generations: [{ text: message.text, message }] };
  }
}

/**
 * Pone un circuit breaker (opossum) delante del proveedor del modelo (regla 11 de CLAUDE.md). Se llama UNA vez, desde el composition root:
 * un breaker por pregunta no acumularía fallos. Cada llamada del bucle del agente al modelo pasa por él.
 *
 * - Con el circuito abierto lanza `ModelBreakerOpenError` SIN llamar al modelo: la pregunta falla al instante.
 * - Cuentan como fallo los 5xx, los timeouts, los errores de red y el 408/429. No cuentan los demás 4xx ni lo cancelado desde fuera.
 * - Los reintentos del propio cliente (uno) caben dentro de una llamada del breaker: es una sola llamada para el circuito.
 */
export function createGuardedChatModel(options: GuardedChatModelOptions): GuardedChatModel {
  return new GuardedChatModelImpl(new ModelGuard(options.breaker, options.maxConcurrency, options.logger), options.model, options.model);
}
