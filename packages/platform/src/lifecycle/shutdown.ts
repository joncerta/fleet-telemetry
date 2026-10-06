import type { Logger } from "../logger/logger.js";

export interface ShutdownStep {
  /** Aparece en los logs. */
  name: string;
  run(): Promise<void>;
}

/** Lo que se usa de `process`: permite inyectar un `EventEmitter` en los tests. */
export interface ShutdownEventSource {
  on(event: string, listener: (arg: unknown) => void): unknown;
  off(event: string, listener: (arg: unknown) => void): unknown;
}

export interface GracefulShutdownOptions {
  logger: Pick<Logger, "info" | "warn" | "error">;
  /** Se ejecutan en orden, de una en una: primero se deja de aceptar trabajo y al final se cierran las conexiones. */
  steps: readonly ShutdownStep[];
  /** Tope de todo el apagado. Si se agota, el proceso sale con código 1 aunque haya trabajo pendiente. */
  timeoutMs: number;
  /** Señales que inician el apagado. Por defecto `SIGTERM` (orquestador) y `SIGINT` (Ctrl+C). */
  signals?: readonly NodeJS.Signals[];
  /** Cómo termina el proceso. Por defecto `process.exit`; los tests inyectan uno propio. */
  exit?: (code: number) => void;
  /** Fuente de señales y errores. Por defecto `process`; los tests inyectan un `EventEmitter`. */
  target?: ShutdownEventSource;
}

export interface GracefulShutdown {
  /** Inicia el apagado (idempotente: una segunda llamada espera el mismo apagado). Devuelve el código de salida. */
  shutdown: (reason: string, exitCode?: number) => Promise<number>;
  /** Quita los manejadores de señales; solo para tests. */
  dispose: () => void;
}

/**
 * Apagado ordenado compartido por los servicios (regla de la fase 1a: dejar de aceptar trabajo, terminar lo que
 * está en vuelo y desconectar).
 *
 * - Cada paso corre en orden y espera a terminar. Si uno falla, se registra y los siguientes corren igual: no se
 *   deja un productor abierto porque falló el cierre del servidor.
 * - Un tope global (`timeoutMs`) evita quedarse colgado indefinidamente: al agotarse sale con código 1.
 * - Una señal repetida durante el apagado se ignora (se espera el mismo apagado).
 * - `unhandledRejection` y `uncaughtException` inician el apagado con código 1: un proceso en estado desconocido no
 *   sigue aceptando trabajo.
 * - Los errores se registran con `err` (serializador de la plataforma, sin datos de negocio).
 */
export function installGracefulShutdown(options: GracefulShutdownOptions): GracefulShutdown {
  const { logger, steps, timeoutMs } = options;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const target = options.target ?? process;
  const signals = options.signals ?? (["SIGTERM", "SIGINT"] as const);

  let running: Promise<number> | undefined;

  function shutdown(reason: string, requestedCode = 0): Promise<number> {
    if (running !== undefined) {
      logger.warn({ reason }, "Apagado ya en curso: se espera a que termine");
      return running;
    }
    running = (async () => {
      logger.info({ reason }, "Iniciando apagado ordenado");
      let failed = requestedCode !== 0;
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      });

      const runSteps = (async () => {
        for (const step of steps) {
          try {
            await step.run();
            logger.info({ step: step.name }, "Paso de apagado completado");
          } catch (err) {
            failed = true;
            logger.error({ err, step: step.name }, "Falló un paso del apagado: se continúa con el siguiente");
          }
        }
        return "done" as const;
      })();

      const outcome = await Promise.race([runSteps, timedOut]);
      clearTimeout(timer);
      if (outcome === "timeout") {
        logger.error({ timeoutMs }, "El apagado superó su tope: se fuerza la salida");
        exit(1);
        return 1;
      }
      const code = failed ? 1 : 0;
      logger.info({ exitCode: code }, "Apagado completado");
      exit(code);
      return code;
    })();
    return running;
  }

  const signalHandlers = signals.map((signal) => ({ signal, handler: () => void shutdown(signal) }));
  const onFatal = (kind: string) => (err: unknown) => {
    logger.error({ err }, `Error no controlado (${kind})`);
    void shutdown(kind, 1);
  };
  const onRejection = onFatal("unhandledRejection");
  const onException = onFatal("uncaughtException");

  for (const { signal, handler } of signalHandlers) target.on(signal, handler);
  target.on("unhandledRejection", onRejection);
  target.on("uncaughtException", onException);

  return {
    shutdown,
    dispose() {
      for (const { signal, handler } of signalHandlers) target.off(signal, handler);
      target.off("unhandledRejection", onRejection);
      target.off("uncaughtException", onException);
    },
  };
}
