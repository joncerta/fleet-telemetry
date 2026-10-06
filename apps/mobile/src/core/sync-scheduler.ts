import { PARAMS } from "./params";
import type { DrainResult } from "./sync-engine";

export interface SchedulerDeps {
  drain(options: { force?: boolean }): Promise<DrainResult>;
  pendingCount(): Promise<number>;
  readonly periodicMs?: number;
  /** Tope de la espera aleatoria al recuperar la red, para que una flota no golpee la API en el mismo segundo. */
  readonly regainJitterMaxMs?: number;
  readonly random?: () => number;
}

/**
 * Cuándo intentar el sync desde la app abierta (la tarea en segundo plano drena por su cuenta):
 * - recuperación de red (con jitter);
 * - cada `periodicMs` (15 s) mientras haya pendientes y no se sepa que no hay internet;
 * - al volver a primer plano.
 * Nunca un loop apretado: un `more_pending` reintenta tras una pausa corta y el motor aplica el backoff por su cuenta.
 *
 * `reachable` viene de netinfo `isInternetReachable` (true, false o null al inicio). Solo decide CUÁNDO intentar: con
 * `null` se intenta igual, y manda el resultado real del request.
 */
export class SyncScheduler {
  readonly #d: SchedulerDeps;
  #interval: ReturnType<typeof setInterval> | null = null;
  #regainTimer: ReturnType<typeof setTimeout> | null = null;
  #reachable: boolean | null = null;

  constructor(deps: SchedulerDeps) {
    this.#d = deps;
  }

  start(): void {
    if (this.#interval !== null) return;
    this.#interval = setInterval(() => void this.#tick(), this.#d.periodicMs ?? PARAMS.periodicSyncMs);
  }

  stop(): void {
    if (this.#interval !== null) clearInterval(this.#interval);
    if (this.#regainTimer !== null) clearTimeout(this.#regainTimer);
    this.#interval = null;
    this.#regainTimer = null;
  }

  setReachable(reachable: boolean | null): void {
    const regained = reachable === true && this.#reachable !== true;
    this.#reachable = reachable;
    if (reachable === false && this.#regainTimer !== null) {
      clearTimeout(this.#regainTimer);
      this.#regainTimer = null;
    }
    if (regained && this.#regainTimer === null) {
      const delay = Math.floor((this.#d.random ?? Math.random)() * (this.#d.regainJitterMaxMs ?? 2_000));
      this.#regainTimer = setTimeout(() => {
        this.#regainTimer = null;
        void this.#run(true);
      }, delay);
    }
  }

  onForeground(): void {
    void this.#tick();
  }

  async #tick(): Promise<void> {
    if (this.#reachable === false) return;
    if ((await this.#d.pendingCount()) === 0) return;
    await this.#run(false);
  }

  async #run(force: boolean): Promise<void> {
    const result = await this.#d.drain({ force }).catch(() => null);
    if (result?.outcome === "more_pending") {
      setTimeout(() => void this.#run(false), 250);
    }
  }
}
