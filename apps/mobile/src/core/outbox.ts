import type { TelemetryPoint } from "@fleet/contracts";
import { PARAMS } from "./params";
import type { OutboxStore } from "./store";

export interface OutboxDeps {
  readonly store: OutboxStore;
  readonly now: () => number;
  readonly cap?: number;
  /** Aviso (sin coordenadas) cuando el tope descarta puntos. */
  readonly onDiscard?: (count: number) => void;
}

/**
 * Entrada de la cola para la captura. Es lo ÚNICO que la tarea en segundo plano y la UI llaman para registrar un
 * punto: el punto se escribe en SQLite (vía el puerto) ANTES de cualquier intento de envío; nunca se envía desde memoria.
 *
 * El punto ya debe haber pasado `telemetryPointSchema` (`buildPoint`).
 */
export class Outbox {
  readonly #deps: OutboxDeps;

  constructor(deps: OutboxDeps) {
    this.#deps = deps;
  }

  async enqueue(point: TelemetryPoint): Promise<{ discarded: number }> {
    const { discarded } = await this.#deps.store.enqueue(
      { eventId: point.eventId, payload: JSON.stringify(point), createdAt: this.#deps.now() },
      this.#deps.cap ?? PARAMS.queueCap,
    );
    if (discarded > 0) this.#deps.onDiscard?.(discarded);
    return { discarded };
  }

  async countInvalid(): Promise<void> {
    await this.#deps.store.countInvalidLocal();
  }
}
