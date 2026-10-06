import { MAX_BATCH_POINTS, type TelemetryPoint } from "@fleet/contracts";
import { randomUUID } from "node:crypto";
import type { Sender } from "./sender.js";
import type { StatsCollector } from "./stats.js";

/**
 * Cola de envío de un vehículo: los puntos que aún no tienen ACK. Un lote que falla por algo transitorio se reintenta con los
 * mismos `eventId` (idempotente en el gateway y en el processor); un rechazo del ACK o un 4xx permanente se descartan, porque
 * reintentarlos no cambia nada. El tope de la cola es el máximo de un lote: si el gateway lleva rato caído, se descartan los
 * más viejos (y se cuentan en `dropped`).
 */
export interface VehicleOutbox {
  enqueue(points: readonly TelemetryPoint[]): void;
  pending(): number;
  /** Envía hasta un lote de lo pendiente. No hace nada si no hay nada. */
  flush(): Promise<void>;
}

export interface VehicleOutboxOptions {
  tenantId: string;
  token: string;
  sender: Sender;
  stats: StatsCollector;
  now: () => Date;
  newCorrelationId?: () => string;
}

export function createVehicleOutbox(options: VehicleOutboxOptions): VehicleOutbox {
  const { tenantId, token, sender, stats, now } = options;
  const newCorrelationId = options.newCorrelationId ?? randomUUID;
  let queue: TelemetryPoint[] = [];

  return {
    enqueue(points) {
      queue.push(...points);
      if (queue.length > MAX_BATCH_POINTS) {
        stats.recordDropped(tenantId, queue.length - MAX_BATCH_POINTS);
        queue = queue.slice(queue.length - MAX_BATCH_POINTS);
      }
    },
    pending: () => queue.length,
    async flush() {
      if (queue.length === 0) return;
      const batch = queue.slice(0, MAX_BATCH_POINTS);
      const outcome = await sender.send({ token, points: batch, correlationId: newCorrelationId(), sentAt: now() });
      if (outcome.kind === "acked") {
        queue = queue.slice(batch.length);
        stats.recordAck(tenantId, {
          sent: batch.length,
          accepted: outcome.ack.accepted.length,
          rejected: outcome.ack.rejected.length,
          latencyMs: outcome.latencyMs,
        });
      } else if (outcome.kind === "permanent") {
        queue = queue.slice(batch.length);
        stats.recordFailure(tenantId, { sent: batch.length, dropped: batch.length });
      } else {
        stats.recordFailure(tenantId, { sent: batch.length, dropped: 0 });
      }
    },
  };
}
