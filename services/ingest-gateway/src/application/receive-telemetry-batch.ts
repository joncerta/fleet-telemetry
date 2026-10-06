import type { BatchAck, TelemetryBatchEnvelope, TelemetryDlqMessage, TelemetryRawEvent } from "@fleet/contracts";
import type { DeviceContext } from "../domain/device.js";
import { evaluateBatch, type RejectedEntry } from "../domain/evaluate-batch.js";
import { PublicationFailedError, type PublicationTarget } from "./errors.js";
import type { Clock, PublishContext, TelemetryPublisher } from "./ports.js";

export interface ReceiveTelemetryBatchDependencies {
  readonly publisher: TelemetryPublisher;
  readonly clock: Clock;
  /** Cuánto puede adelantarse `recordedAt` a la hora del servidor antes de rechazar el punto (`future_timestamp`). */
  readonly futureToleranceMs: number;
  /** Antigüedad máxima de `recordedAt` respecto de la hora del servidor; más viejo es `stale_timestamp`. */
  readonly maxAgeMs: number;
  /** Tamaño máximo de un punto serializado, en bytes; más grande es `invalid_schema` (y a la DLQ va solo su inicio). */
  readonly maxPointBytes: number;
}

export interface ReceiveTelemetryBatchInput {
  /** Identidad verificada del token. Es lo único que dice de qué tenant, dispositivo y vehículo es el lote. */
  readonly device: DeviceContext;
  readonly correlationId: string;
  /** Envelope ya validado con `telemetryBatchEnvelopeSchema`; sus puntos se validan uno a uno aquí. */
  readonly envelope: TelemetryBatchEnvelope;
}

export type ReceiveTelemetryBatch = (input: ReceiveTelemetryBatchInput) => Promise<BatchAck>;

/**
 * Caso de uso de `POST /v1/telemetry/batches`: valida cada punto, publica los válidos en `telemetry.raw` y los
 * rechazados en `telemetry.dlq`, y devuelve el ACK del lote.
 *
 * Solo hay ACK si AMBAS publicaciones se confirmaron. Si cualquiera falla lanza `PublicationFailedError` (nunca un ACK
 * parcial): el móvil reintenta el lote completo, que es seguro porque la persistencia es idempotente por `eventId`.
 * Las dos publicaciones se esperan siempre hasta el final (`allSettled`): así la respuesta no sale mientras la otra
 * publicación sigue en curso. Eso NO evita los envíos huérfanos: cuando una publicación vence su timeout, el envío de
 * kafkajs sigue en vuelo. Eso lo acota el publicador con su tope de envíos en vuelo (`maxInFlight`).
 */
export function createReceiveTelemetryBatch(deps: ReceiveTelemetryBatchDependencies): ReceiveTelemetryBatch {
  return async ({ device, correlationId, envelope }) => {
    const receivedAt = deps.clock.now();
    const { valid, rejected } = evaluateBatch(envelope.points, {
      vehicleId: device.vehicleId,
      now: receivedAt,
      futureToleranceMs: deps.futureToleranceMs,
      maxAgeMs: deps.maxAgeMs,
      maxPointBytes: deps.maxPointBytes,
    });

    const events: TelemetryRawEvent[] = valid.map((point) => ({
      schemaVersion: 1,
      tenantId: device.tenantId,
      deviceId: device.deviceId,
      receivedAt: receivedAt.toISOString(),
      point,
    }));
    const dlqMessages = rejected.map((entry) => toDlqMessage(entry, device, receivedAt));
    const context: PublishContext = { vehicleId: device.vehicleId, correlationId };

    const publications: readonly { target: PublicationTarget; run: () => Promise<void> }[] = [
      ...(events.length > 0 ? [{ target: "telemetry.raw" as const, run: () => deps.publisher.publishAccepted(context, events) }] : []),
      ...(dlqMessages.length > 0 ? [{ target: "telemetry.dlq" as const, run: () => deps.publisher.publishRejected(context, dlqMessages) }] : []),
    ];
    // `async` convierte también un lanzamiento síncrono del publicador en un rechazo.
    const outcomes = await Promise.allSettled(publications.map(async ({ run }) => run()));
    const failedTargets = publications.flatMap(({ target }, i) => (outcomes[i]?.status === "rejected" ? [target] : []));
    const firstFailure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    if (firstFailure !== undefined) throw new PublicationFailedError(failedTargets, firstFailure.reason);

    return {
      schemaVersion: 1,
      accepted: valid.map((point) => point.eventId),
      rejected: rejected.map(({ index, eventId, reason, detail }) => ({ index, eventId, reason, detail })),
      serverTime: deps.clock.now().toISOString(),
    };
  };
}

function toDlqMessage(entry: RejectedEntry, device: DeviceContext, failedAt: Date): TelemetryDlqMessage {
  return {
    schemaVersion: 1,
    source: "ingest-gateway",
    reason: { code: entry.reason, message: entry.detail },
    failedAt: failedAt.toISOString(),
    tenantId: device.tenantId,
    deviceId: device.deviceId,
    // El vehículo del token, no el que declaraba el punto: es el autenticado, y es la key de Kafka de la DLQ.
    vehicleId: device.vehicleId,
    eventId: entry.eventId,
    attempts: 0,
    originalPayload: entry.original,
    ...(entry.truncatedFromBytes !== undefined && { truncatedFromBytes: entry.truncatedFromBytes }),
  };
}
