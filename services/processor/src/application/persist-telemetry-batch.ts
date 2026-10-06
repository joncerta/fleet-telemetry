import type { TelemetryRawEvent } from "@fleet/contracts";
import { evaluateMessage, type KnownIds, type MessageRejectionCode, type OriginalPayload } from "../domain/evaluate-message.js";
import { classifyFailure, describeFailure } from "../domain/failure-classification.js";
import { backoffDelayMs, type BackoffPolicy } from "../domain/retry-policy.js";
import { DeadLetterPublicationError, PersistenceUnavailableError, UnsupportedSchemaVersionError } from "./errors.js";
import type {
  BatchCheckpoint,
  Clock,
  DeadLetterEntry,
  DeadLetterPublisher,
  ProcessorLogger,
  Randomness,
  Sleeper,
  TelemetryRepository,
} from "./ports.js";

export interface PersistTelemetryBatchDependencies {
  readonly repository: TelemetryRepository;
  readonly deadLetters: DeadLetterPublisher;
  readonly clock: Clock;
  readonly sleeper: Sleeper;
  readonly random: Randomness;
  readonly logger: ProcessorLogger;
  /** Intentos totales por operación de persistencia ante un fallo transitorio (el primero cuenta). */
  readonly maxAttempts: number;
  readonly backoff: BackoffPolicy;
  /** Mensajes por tramo: cada tramo es un INSERT, y al terminar se resuelve su offset. */
  readonly chunkSize: number;
  /**
   * Cada cuántos ms debe latir el heartbeat durante una espera. El backoff puede superar el `sessionTimeout` del consumer
   * (30 s): sin latir en tramos, el broker lo daría por muerto y reasignaría la partición a mitad del reintento.
   */
  readonly heartbeatIntervalMs: number;
}

export interface IncomingMessage {
  readonly offset: string;
  /** Key del mensaje de Kafka (el `vehicleId` que puso el gateway), o `null`. */
  readonly key: string | null;
  /** Valor del mensaje decodificado como UTF-8, o `null` si no tiene (tombstone). */
  readonly value: string | null;
  /** Ya resuelto por la entrada: el del header del mensaje o, si no venía o era inválido, uno nuevo. */
  readonly correlationId: string;
}

export interface PersistTelemetryInput {
  readonly partition: number;
  /** Mensajes de UNA partición, en orden de offset. */
  readonly messages: readonly IncomingMessage[];
  readonly checkpoint: BatchCheckpoint;
}

type DeadLetterCode = MessageRejectionCode | "processing_failed";

export interface PersistReport {
  /** Filas nuevas insertadas. */
  readonly persisted: number;
  /** Puntos válidos que ya existían (reentrega, reenvío del móvil o repetido en el lote). */
  readonly duplicates: number;
  readonly deadLettered: Readonly<Record<DeadLetterCode, number>>;
  /** `true` si se dejó de procesar a medias porque el consumer se detenía o la partición se reasignó. */
  readonly stopped: boolean;
}

export type PersistTelemetryBatch = (input: PersistTelemetryInput) => Promise<PersistReport>;

const DEAD_LETTER_CODES: readonly DeadLetterCode[] = ["invalid_schema", "stale_timestamp", "outside_operating_area", "processing_failed"];
const MAX_LOGGED_IDS = 20;
const UNKNOWN_KEY = "unknown";

interface Valid {
  readonly message: IncomingMessage;
  readonly event: TelemetryRawEvent;
  readonly original: OriginalPayload;
  readonly ids: KnownIds;
}

interface Pending {
  readonly message: IncomingMessage;
  readonly code: DeadLetterCode;
  readonly detail: string;
  readonly attempts: number;
  readonly original: OriginalPayload;
  readonly ids: KnownIds;
}

type Attempted<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown; readonly attempts: number };

/**
 * Caso de uso del consumer de `telemetry.raw`: persiste un lote de Kafka (una partición, en orden) de forma idempotente.
 *
 * El lote se procesa por tramos de `chunkSize` mensajes. Cada tramo:
 * 1. evalúa cada mensaje con el dominio: `invalid_schema`, `stale_timestamp` y `outside_operating_area` van a la DLQ SIN reintentos;
 * 2. inserta los válidos con un solo `insertBatch` (idempotente: `ON CONFLICT DO NOTHING`);
 * 3. publica en la DLQ lo rechazado y lo que no se pudo persistir, y espera la confirmación del broker;
 * 4. SOLO entonces resuelve el offset del último mensaje del tramo, late el heartbeat y lo confirma en el broker.
 * La base se escribe antes que la DLQ a propósito: con la base caída no se publica nada, así que las reentregas no
 * llenan la DLQ de duplicados.
 *
 * Fallos de la persistencia (`classifyFailure`, que FALLA EN CERRADO):
 * - TRANSITORIO (todo lo que no es atribuible a la fila, incluido lo desconocido): se reintenta la operación con backoff
 *   exponencial y jitter, hasta `maxAttempts`, latiendo el heartbeat durante la espera. Si se agota no es un mensaje malo: NO
 *   va a la DLQ, se registra un error, se lanza `PersistenceUnavailableError` y no se resuelve el offset del tramo; kafkajs
 *   reentrega el lote (at-least-once, y el sumidero es idempotente). La partición queda detenida hasta que la base responda.
 * - PERMANENTE (SQLSTATE de clase 22 o 23, atribuible a la fila): no se reintenta. Se aísla fila por fila (cada una con la
 *   misma política de reintentos): la que sigue fallando va a la DLQ como `processing_failed` con `attempts` y las demás se
 *   persisten. El aislamiento late el heartbeat tras cada fila, consulta `shouldContinue` antes de cada una (si da falso sale
 *   sin publicar la DLQ ni resolver el tramo) y, si fallan TODAS las filas (con más de una), no hay una fila venenosa sino un
 *   problema de la base: lanza `PersistenceUnavailableError` en vez de vaciar el tramo en la DLQ.
 *
 * Versión: un mensaje con una `schemaVersion` mayor que la conocida (`unsupported_version`) NO es contenido roto, sino un productor
 * desplegado antes que este consumer: no va a la DLQ. Se lanza `UnsupportedSchemaVersionError` antes de tocar el tramo, no se
 * resuelve su offset y la partición queda detenida hasta desplegar la versión nueva (regla 7; ADR-005.14).
 *
 * Si la DLQ no confirma, se lanza `DeadLetterPublicationError` y el offset del tramo no se resuelve.
 *
 * Antigüedad: un punto de más de 90 días (la retención de `telemetry`) va a la DLQ como `stale_timestamp`, sin reintentos. La
 * cota es la retención y NO los 7 días del gateway: el gateway pudo aceptar un punto válido que espere días en Kafka si el
 * processor estuvo caído, y rechazarlo con la cota del gateway sería perder datos aceptados.
 *
 * Sin `vehicle_state`, `vehicle.state` ni `fleet.alerts`: eso es de la fase 1b.
 */
export function createPersistTelemetryBatch(deps: PersistTelemetryBatchDependencies): PersistTelemetryBatch {
  const { repository, deadLetters, clock, sleeper, random, logger } = deps;

  /** Espera `totalMs` en tramos de a lo sumo `heartbeatIntervalMs`, latiendo después de cada uno. */
  async function sleepWithHeartbeat(totalMs: number, checkpoint: BatchCheckpoint): Promise<void> {
    for (let remainingMs = totalMs; remainingMs > 0; ) {
      const sliceMs = Math.min(remainingMs, deps.heartbeatIntervalMs);
      await sleeper.sleep(sliceMs);
      remainingMs -= sliceMs;
      await checkpoint.heartbeat();
    }
  }

  /** Falla de infraestructura: se registra a la vista (la partición se detiene) y se devuelve el error a lanzar. Sin datos del mensaje. */
  function unavailable(attempts: number, cause: unknown, context: Record<string, unknown>, reason: string): PersistenceUnavailableError {
    logger.error({ ...context, attempts, failure: describeFailure(cause) }, reason);
    return new PersistenceUnavailableError(attempts, cause);
  }

  async function attempt<T>(operation: () => Promise<T>, context: Record<string, unknown>, checkpoint: BatchCheckpoint): Promise<Attempted<T>> {
    for (let attemptNumber = 1; ; attemptNumber += 1) {
      try {
        return { ok: true, value: await operation() };
      } catch (error) {
        if (classifyFailure(error) === "permanent") return { ok: false, error, attempts: attemptNumber };
        if (attemptNumber >= deps.maxAttempts) {
          throw unavailable(attemptNumber, error, context, "La base no atendió la persistencia tras agotar los reintentos: la partición se detiene y el offset no avanza");
        }
        const delayMs = backoffDelayMs(attemptNumber, deps.backoff, random.next());
        logger.warn(
          { ...context, attempt: attemptNumber, maxAttempts: deps.maxAttempts, delayMs, failure: describeFailure(error) },
          "Fallo transitorio al persistir: se reintenta",
        );
        await sleepWithHeartbeat(delayMs, checkpoint);
      }
    }
  }

  async function persist(
    valid: readonly Valid[],
    context: Record<string, unknown>,
    checkpoint: BatchCheckpoint,
  ): Promise<{ persisted: number; duplicates: number; failed: Pending[]; stopped: boolean }> {
    if (valid.length === 0) return { persisted: 0, duplicates: 0, failed: [], stopped: false };

    const whole = await attempt(() => repository.insertBatch(valid.map(({ event }) => event)), context, checkpoint);
    if (whole.ok) return { persisted: whole.value.inserted, duplicates: valid.length - whole.value.inserted, failed: [], stopped: false };

    logger.warn({ ...context, rows: valid.length, failure: describeFailure(whole.error) }, "Fallo permanente del lote: se aísla fila por fila");
    let persisted = 0;
    let duplicates = 0;
    const failed: Pending[] = [];
    let firstFailure: { readonly error: unknown; readonly attempts: number } | undefined;
    for (const row of valid) {
      // El aislamiento puede ser largo (una fila por INSERT, cada una con sus reintentos): no se sigue si el consumer se detiene.
      if (!checkpoint.shouldContinue()) return { persisted, duplicates, failed, stopped: true };
      const single = await attempt(() => repository.insertBatch([row.event]), context, checkpoint);
      if (single.ok) {
        persisted += single.value.inserted;
        duplicates += 1 - single.value.inserted;
      } else {
        firstFailure ??= { error: single.error, attempts: single.attempts };
        failed.push({
          message: row.message,
          code: "processing_failed",
          detail: `Falló la persistencia (${describeFailure(single.error)}).`,
          attempts: single.attempts,
          original: row.original,
          ids: row.ids,
        });
      }
      await checkpoint.heartbeat();
    }
    // Si fallaron todas, no hay una fila venenosa: el problema es la base (esquema, permisos, restricción). Mandar el tramo
    // entero a la DLQ y confirmar el offset sería perderlo.
    if (valid.length > 1 && failed.length === valid.length && firstFailure !== undefined) {
      throw unavailable(
        firstFailure.attempts,
        firstFailure.error,
        { ...context, rows: valid.length },
        "Fallaron TODAS las filas aisladas del tramo: no hay una fila venenosa, es la base. La partición se detiene y el offset no avanza",
      );
    }
    return { persisted, duplicates, failed, stopped: false };
  }

  const toEntry = (pending: Pending): DeadLetterEntry => ({
    // El vehículo, si se conoce, es la key de la DLQ (mismo orden por vehículo); si no, la key del mensaje original.
    key: pending.ids.vehicleId ?? pending.message.key ?? UNKNOWN_KEY,
    correlationId: pending.message.correlationId,
    message: {
      schemaVersion: 1,
      source: "processor",
      reason: { code: pending.code, message: pending.detail },
      failedAt: clock.now().toISOString(),
      tenantId: pending.ids.tenantId,
      deviceId: pending.ids.deviceId,
      vehicleId: pending.ids.vehicleId,
      eventId: pending.ids.eventId,
      attempts: pending.attempts,
      originalPayload: pending.original,
    },
  });

  async function processChunk(chunk: readonly IncomingMessage[], partition: number, checkpoint: BatchCheckpoint) {
    const valid: Valid[] = [];
    const pending: Pending[] = [];
    const rules = { now: clock.now() };
    for (const message of chunk) {
      const verdict = evaluateMessage(message.value, rules);
      if (verdict.kind === "unsupported_version") {
        // Antes de persistir o publicar nada del tramo: la partición se detiene hasta desplegar la versión nueva. Solo números.
        logger.error(
          { partition, offset: message.offset, schemaVersion: verdict.version, correlationId: message.correlationId },
          "Mensaje con una schemaVersion que este processor no conoce: la partición se detiene hasta desplegar la versión nueva (no va a la DLQ)",
        );
        throw new UnsupportedSchemaVersionError(verdict.version, message.offset);
      }
      if (verdict.kind === "valid") valid.push({ message, event: verdict.event, original: verdict.original, ids: verdict.ids });
      else pending.push({ message, code: verdict.code, detail: verdict.detail, attempts: 0, original: verdict.original, ids: verdict.ids });
    }

    const context = {
      partition,
      firstOffset: chunk[0]?.offset,
      lastOffset: chunk.at(-1)?.offset,
      correlationIds: [...new Set(chunk.map((message) => message.correlationId))].slice(0, MAX_LOGGED_IDS),
    };
    const persisted = await persist(valid, context, checkpoint);
    if (persisted.stopped) {
      // El consumer se detiene: lo ya insertado quedó (idempotente), pero ni se publica la DLQ ni se resuelve el tramo.
      return { persisted: persisted.persisted, duplicates: persisted.duplicates, deadLettered: countByCode([]), stopped: true };
    }
    pending.push(...persisted.failed);

    if (pending.length > 0) {
      const entries = pending.map(toEntry);
      try {
        await deadLetters.publish(entries);
      } catch (error) {
        throw new DeadLetterPublicationError(entries.length, error);
      }
      for (const item of pending) {
        logger.warn(
          {
            code: item.code,
            attempts: item.attempts,
            partition,
            offset: item.message.offset,
            eventId: item.ids.eventId,
            tenantId: item.ids.tenantId,
            vehicleId: item.ids.vehicleId,
            correlationId: item.message.correlationId,
          },
          "Mensaje enviado a la DLQ",
        );
      }
    }

    const deadLettered = countByCode(pending);
    logger.info(
      {
        ...context,
        messages: chunk.length,
        persisted: persisted.persisted,
        duplicates: persisted.duplicates,
        deadLettered,
        tenantIds: [...new Set(valid.map(({ event }) => event.tenantId))].slice(0, MAX_LOGGED_IDS),
        vehicles: new Set(valid.map(({ event }) => event.point.vehicleId)).size,
      },
      "Tramo de telemetría procesado",
    );
    return { persisted: persisted.persisted, duplicates: persisted.duplicates, deadLettered, stopped: false };
  }

  return async ({ partition, messages, checkpoint }) => {
    let persisted = 0;
    let duplicates = 0;
    const deadLettered = countByCode([]);
    let stopped = false;

    for (let start = 0; start < messages.length; start += deps.chunkSize) {
      if (!checkpoint.shouldContinue()) {
        stopped = true;
        logger.info({ partition, nextOffset: messages[start]?.offset }, "Se deja de procesar el lote: el consumer se detiene o la partición se reasignó");
        break;
      }
      const chunk = messages.slice(start, start + deps.chunkSize);
      const result = await processChunk(chunk, partition, checkpoint);
      persisted += result.persisted;
      duplicates += result.duplicates;
      for (const code of DEAD_LETTER_CODES) deadLettered[code] += result.deadLettered[code];
      if (result.stopped) {
        stopped = true;
        logger.info({ partition, nextOffset: chunk[0]?.offset }, "Se deja de procesar el tramo: el consumer se detiene o la partición se reasignó");
        break;
      }

      // Persistido y con la DLQ confirmada: ahora sí se puede avanzar el offset (regla 6) y confirmarlo en el broker.
      const last = chunk.at(-1);
      if (last !== undefined) checkpoint.resolve(last.offset);
      await checkpoint.heartbeat();
      if (last !== undefined) await checkpoint.commit(last.offset);
    }

    return { persisted, duplicates, deadLettered, stopped };
  };
}

function countByCode(pending: readonly Pending[]): Record<DeadLetterCode, number> {
  const counts: Record<DeadLetterCode, number> = { invalid_schema: 0, stale_timestamp: 0, outside_operating_area: 0, processing_failed: 0 };
  for (const item of pending) counts[item.code] += 1;
  return counts;
}
