import { apiErrorSchema, batchAckTolerantSchema, type TelemetryBatchEnvelope } from "@fleet/contracts";
import { backoffDelayMs, delayWithRetryAfter, parseRetryAfter } from "./backoff";
import { PARAMS } from "./params";
import type { OutboxEntry, OutboxStore } from "./store";
import { estimateClockSkewMs } from "./tracking-state";

/** Respuesta HTTP cruda. El transporte NO lanza por un 4xx/5xx: solo lanza por red o timeout. */
export interface TransportResponse {
  readonly status: number;
  /** Cuerpo ya leído como JSON; `undefined` si no era JSON. */
  readonly body: unknown;
  readonly retryAfterHeader: string | null;
}

export interface BatchTransport {
  /** Rechaza (lanza) con red caída o timeout. */
  send(args: { body: TelemetryBatchEnvelope; token: string }): Promise<TransportResponse>;
}

/** Fuente del token del dispositivo. La vinculación futura solo cambia quién lo entrega, no la cola ni el sync. */
export interface TokenSource {
  getToken(): Promise<string | null>;
}

export type DrainOutcome =
  /** No había nada que enviar. */
  | "idle"
  /** Se drenó todo lo que había. */
  | "drained"
  /** Se enviaron lotes pero queda cola (se alcanzó `maxBatches`); conviene volver a llamar pronto. */
  | "more_pending"
  /** Fallo transitorio: nada se borró; hay que esperar (`nextAttemptAt`). */
  | "backoff"
  /** 401/403: sync detenido hasta `resume()`. */
  | "paused"
  /** Otra llamada de este proceso ya está drenando. */
  | "busy";

export interface DrainResult {
  readonly outcome: DrainOutcome;
  readonly sent: number;
  readonly rejected: number;
  readonly batches: number;
  readonly nextAttemptAt: number | null;
}

export type SyncPhase = "idle" | "syncing" | "backoff" | "paused";

export interface SyncEngineDeps {
  readonly store: OutboxStore;
  readonly transport: BatchTransport;
  readonly tokens: TokenSource;
  readonly now: () => number;
  readonly random?: () => number;
  readonly newBatchId: () => string;
  readonly maxBatchPoints?: number;
  readonly maxBatchBytes?: number;
  readonly leaseMs?: number;
  readonly unauthorizedProbeMs?: number;
  /** Eventos sin datos personales, para logs y diagnóstico. */
  readonly onEvent?: (event: SyncEvent) => void;
}

export type SyncEvent =
  | { type: "phase"; phase: SyncPhase }
  | { type: "batch_acked"; sent: number; rejected: number; released: number }
  | { type: "error"; code: string };

const DEFAULT_MAX_BATCHES = 50;

/**
 * Drena la cola en lotes, en orden de captura. Reglas de `apps/mobile/CLAUDE.md`:
 * 202 + ACK válido borra `accepted`, mueve `rejected` y devuelve el resto a `pending`; 202 con cuerpo inválido no borra
 * nada; 400 -> `dead`; 401/403 pausa; 413 parte el lote; 429/5xx/red -> backoff con jitter respetando `Retry-After`.
 *
 * Un solo envío a la vez: dentro del proceso por `#running`, y entre procesos (tarea en segundo plano y UI) por el
 * `claim` atómico del puerto. Un reenvío es seguro: el `eventId` hace idempotente al back.
 */
export class SyncEngine {
  readonly #d: SyncEngineDeps;
  readonly #maxPoints: number;
  readonly #maxBytes: number;
  readonly #leaseMs: number;
  readonly #probeMs: number;
  readonly #random: () => number;
  #batchLimit: number;
  #running = false;
  #phase: SyncPhase = "idle";
  /** Tras un 429 el piso es duro: ni siquiera `force` (recuperación de red) lo salta. */
  #hardBlockUntil = 0;

  constructor(deps: SyncEngineDeps) {
    this.#d = deps;
    this.#maxPoints = deps.maxBatchPoints ?? PARAMS.maxBatchPoints;
    this.#maxBytes = deps.maxBatchBytes ?? PARAMS.maxBatchBytes;
    this.#leaseMs = deps.leaseMs ?? PARAMS.leaseMs;
    this.#probeMs = deps.unauthorizedProbeMs ?? PARAMS.unauthorizedProbeMs;
    this.#random = deps.random ?? Math.random;
    this.#batchLimit = this.#maxPoints;
  }

  get phase(): SyncPhase {
    return this.#phase;
  }

  /** Tras guardar un token nuevo: levanta la pausa por 401/403 y el backoff. */
  async resume(): Promise<void> {
    await this.#d.store.setMeta("syncPausedReason", null);
    await this.#d.store.setMeta("syncPausedAt", null);
    await this.#d.store.setMeta("nextAttemptAt", null);
    await this.#d.store.setMeta("backoffAttempt", "0");
    this.#hardBlockUntil = 0;
    this.#setPhase("idle");
  }

  /**
   * Al arrancar: si la versión de la app cambió y el envío estaba pausado por un 400 (`client_error`, bug del cliente),
   * la pausa se levanta: la versión nueva puede traer el arreglo. Devuelve `true` si levantó la pausa.
   */
  async onAppVersion(version: string): Promise<boolean> {
    const { store } = this.#d;
    if ((await store.getMeta("appVersion")) === version) return false;
    await store.setMeta("appVersion", version);
    if ((await store.getMeta("syncPausedReason")) !== "client_error") return false;
    await this.resume();
    return true;
  }

  /**
   * `force`: ignora el backoff (p. ej. volvió la red) pero NO un `Retry-After` ni la pausa por 401.
   */
  async drain(options: { force?: boolean; maxBatches?: number } = {}): Promise<DrainResult> {
    if (this.#running) return this.#result("busy", 0, 0, 0, null);
    this.#running = true;
    try {
      return await this.#drain(options.force === true, options.maxBatches ?? DEFAULT_MAX_BATCHES);
    } finally {
      this.#running = false;
    }
  }

  async #drain(force: boolean, maxBatches: number): Promise<DrainResult> {
    const { store } = this.#d;
    // "Sin vincular" se deduce de las credenciales y no se persiste: vincular lo resuelve solo.
    const token = await this.#d.tokens.getToken();
    if (token === null) {
      this.#setPhase("paused");
      return this.#result("paused", 0, 0, 0, null);
    }

    const now = this.#d.now();
    let probing = false;
    const paused = await store.getMeta("syncPausedReason");
    if (paused !== null) {
      // 401/403: cada N minutos se manda UN lote de prueba; si el servidor responde 202, el token volvió a ser válido.
      // `client_error` (400) solo se levanta con `resume()` o una versión nueva de la app.
      const pausedAt = Number((await store.getMeta("syncPausedAt")) ?? 0);
      probing = paused === "unauthorized" && now - pausedAt >= this.#probeMs;
      if (!probing) {
        this.#setPhase("paused");
        return this.#result("paused", 0, 0, 0, null);
      }
    } else {
      const nextAt = Number((await store.getMeta("nextAttemptAt")) ?? 0);
      if (nextAt > now && !(force && now >= this.#hardBlockUntil)) {
        this.#setPhase("backoff");
        return this.#result("backoff", 0, 0, 0, nextAt);
      }
    }

    await store.reclaimExpired(now, this.#leaseMs);

    this.#setPhase("syncing");
    let sent = 0;
    let rejected = 0;
    let batches = 0;

    while (batches < maxBatches) {
      const claimed = await store.claim(this.#batchLimit, this.#maxBytes, this.#d.now());
      if (claimed.length === 0) {
        if (probing) {
          this.#setPhase("paused");
          return this.#result("paused", sent, rejected, batches, null);
        }
        this.#setPhase("idle");
        return this.#result(batches === 0 ? "idle" : "drained", sent, rejected, batches, null);
      }
      batches++;
      const step = await this.#sendBatch(claimed, token);
      sent += step.sent;
      rejected += step.rejected;
      if (probing && step.stop === null && (await store.getMeta("syncPausedReason")) === null) probing = false;
      if (step.stop !== null) return this.#result(step.stop, sent, rejected, batches, await this.#nextAttemptAt());
    }
    this.#setPhase("idle");
    return this.#result("more_pending", sent, rejected, batches, null);
  }

  async #sendBatch(
    claimed: OutboxEntry[],
    token: string,
  ): Promise<{ sent: number; rejected: number; stop: "backoff" | "paused" | null }> {
    const { store } = this.#d;
    const ids = claimed.map((e) => e.eventId);

    const points: unknown[] = [];
    const corrupt: string[] = [];
    for (const entry of claimed) {
      try {
        points.push(JSON.parse(entry.payload));
      } catch {
        corrupt.push(entry.eventId);
      }
    }
    if (corrupt.length > 0) {
      // Un payload ilegible nunca será enviable: no se reintenta en bucle; queda en `dead` para diagnóstico.
      await store.markDead(this.#d.newBatchId(), corrupt, "corrupt_payload", this.#d.now());
      if (points.length === 0) return { sent: 0, rejected: 0, stop: null };
    }
    const sendIds = ids.filter((id) => !corrupt.includes(id));

    const sentAtMs = this.#d.now();
    const body: TelemetryBatchEnvelope = {
      schemaVersion: 1,
      sentAt: new Date(sentAtMs).toISOString(),
      points,
    };

    let response;
    try {
      response = await this.#d.transport.send({ body, token });
    } catch (error) {
      await store.release(sendIds);
      const code = error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network";
      await this.#fail(code, null, false);
      return { sent: 0, rejected: 0, stop: "backoff" };
    }

    const { status } = response;

    if (status === 202) {
      const ack = batchAckTolerantSchema.safeParse(response.body);
      if (!ack.success) {
        await store.release(sendIds);
        await this.#fail("ack_invalid", null, false);
        return { sent: 0, rejected: 0, stop: "backoff" };
      }
      const result = await store.settle({
        batch: sendIds,
        accepted: ack.data.accepted,
        // Sin eventId en el rechazo (no debería pasar: el punto se validó al capturarlo), `index` apunta al lote.
        rejected: ack.data.rejected.flatMap((r) => {
          const eventId = r.eventId ?? sendIds[r.index];
          return eventId === undefined ? [] : [{ eventId, reason: r.reason }];
        }),
        nowMs: this.#d.now(),
      });
      this.#d.onEvent?.({ type: "batch_acked", ...result });
      // Un 202 válido tras una pausa por 401 (lote de prueba): el token volvió a ser válido.
      await store.setMeta("syncPausedReason", null);
      await store.setMeta("syncPausedAt", null);
      await this.#recordAck(ack.data.serverTime, result.sent, result.rejected, sentAtMs);
      // El lote que funcionó permite volver a crecer tras un 413.
      this.#batchLimit = Math.min(this.#maxPoints, this.#batchLimit * 2);
      if (result.released > 0) {
        // El servidor no confirmó todo: lo ausente sigue pendiente. Backoff para no insistir en bucle.
        await this.#fail("ack_incomplete", null, false);
        return { sent: result.sent, rejected: result.rejected, stop: "backoff" };
      }
      await this.#succeed();
      return { sent: result.sent, rejected: result.rejected, stop: null };
    }

    if (status === 400) {
      // Un 400 es un bug del cliente (o un proxy): UN solo lote a `dead` y el envío se pausa. Seguir reclamando lotes
      // vaciaría la cola entera a `dead` con un error sistemático.
      await store.markDead(this.#d.newBatchId(), sendIds, `http_400:${errorCode(response.body)}`, this.#d.now());
      this.#d.onEvent?.({ type: "error", code: "http_400" });
      await this.#recordError("http_400");
      await this.#pause("client_error");
      return { sent: 0, rejected: 0, stop: "paused" };
    }

    if (status === 401 || status === 403) {
      await store.release(sendIds);
      await this.#recordError(`http_${status}`);
      await this.#pause("unauthorized");
      return { sent: 0, rejected: 0, stop: "paused" };
    }

    if (status === 413) {
      if (sendIds.length === 1) {
        await store.markDead(this.#d.newBatchId(), sendIds, "http_413:single_point_too_large", this.#d.now());
        await this.#recordError("http_413");
        return { sent: 0, rejected: 0, stop: null };
      }
      await store.release(sendIds);
      this.#batchLimit = Math.max(1, Math.floor(sendIds.length / 2));
      return { sent: 0, rejected: 0, stop: null };
    }

    // 429, 5xx y cualquier otro estado inesperado: nada se borra; backoff respetando Retry-After.
    await store.release(sendIds);
    const retryAfter = parseRetryAfter(response.retryAfterHeader, this.#d.now());
    await this.#fail(`http_${status}`, retryAfter, status === 429);
    return { sent: 0, rejected: 0, stop: "backoff" };
  }

  async #fail(code: string, retryAfterMs: number | null, hard: boolean): Promise<void> {
    const { store } = this.#d;
    const attempt = Number((await store.getMeta("backoffAttempt")) ?? 0);
    const delay = delayWithRetryAfter(backoffDelayMs(attempt, this.#random), retryAfterMs);
    const nextAt = this.#d.now() + delay;
    if (hard) this.#hardBlockUntil = nextAt;
    await store.setMeta("nextAttemptAt", String(nextAt));
    await store.setMeta("backoffAttempt", String(attempt + 1));
    await this.#recordError(code);
    this.#d.onEvent?.({ type: "error", code });
    this.#setPhase("backoff");
  }

  async #succeed(): Promise<void> {
    const { store } = this.#d;
    await store.setMeta("backoffAttempt", "0");
    await store.setMeta("nextAttemptAt", null);
    this.#hardBlockUntil = 0;
  }

  async #recordAck(serverTime: string, accepted: number, rejected: number, sentAtMs: number): Promise<void> {
    const { store } = this.#d;
    const skew = estimateClockSkewMs({ serverTime, sentAtMs, receivedAtMs: this.#d.now() });
    await store.setMeta("lastClockSkewMs", skew === null ? null : String(skew));
    await store.setMeta("lastSyncAt", new Date(this.#d.now()).toISOString());
    await store.setMeta("lastServerTime", serverTime);
    await store.setMeta("lastAckAcceptedCount", String(accepted));
    await store.setMeta("lastAckRejectedCount", String(rejected));
  }

  async #recordError(code: string): Promise<void> {
    await this.#d.store.setMeta("lastError", code);
    await this.#d.store.setMeta("lastErrorAt", new Date(this.#d.now()).toISOString());
  }

  async #pause(reason: string): Promise<void> {
    await this.#d.store.setMeta("syncPausedReason", reason);
    await this.#d.store.setMeta("syncPausedAt", String(this.#d.now()));
    this.#setPhase("paused");
  }

  async #nextAttemptAt(): Promise<number | null> {
    const raw = await this.#d.store.getMeta("nextAttemptAt");
    return raw === null ? null : Number(raw);
  }

  #setPhase(phase: SyncPhase): void {
    if (this.#phase === phase) return;
    this.#phase = phase;
    this.#d.onEvent?.({ type: "phase", phase });
  }

  #result(outcome: DrainOutcome, sent: number, rejected: number, batches: number, nextAttemptAt: number | null): DrainResult {
    return { outcome, sent, rejected, batches, nextAttemptAt };
  }
}

/** Código de `apiErrorSchema`, o `unknown`. Nunca el mensaje (podría llevar datos). */
function errorCode(body: unknown): string {
  const parsed = apiErrorSchema.safeParse(body);
  return parsed.success ? parsed.data.error.code.slice(0, 64) : "unknown";
}
