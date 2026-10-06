import { batchAckTolerantSchema, type BatchAckTolerant, type TelemetryPoint } from "@fleet/contracts";

/** Ruta del gateway. No está en `@fleet/contracts` (es del servicio), así que se repite aquí. */
export const TELEMETRY_BATCHES_PATH = "/v1/telemetry/batches";

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export type SendOutcome =
  | { kind: "acked"; ack: BatchAckTolerant; latencyMs: number }
  /** 429, 5xx, red caída, timeout o ACK ilegible: el lote se reintenta tal cual (los `eventId` hacen idempotente el reenvío). */
  | { kind: "retry"; status: number | null; latencyMs: number }
  /** Otro 4xx (envelope roto, token revocado...): reintentar no lo arregla; el lote se descarta. */
  | { kind: "permanent"; status: number; latencyMs: number };

export interface SendBatchInput {
  token: string;
  points: readonly TelemetryPoint[];
  correlationId: string;
  sentAt: Date;
}

export interface Sender {
  send(input: SendBatchInput): Promise<SendOutcome>;
}

export interface SenderOptions {
  gatewayUrl: string;
  fetch: FetchFn;
  /** Reloj monotónico en ms, para la latencia del ACK. */
  nowMs: () => number;
  timeoutMs: number;
}

/**
 * Envía un lote al gateway e interpreta la respuesta. El ACK se lee con el esquema TOLERANTE (un motivo o una versión que esta
 * versión no conoce no lo invalida). Nunca lanza: el resultado dice qué hacer con el lote. El token solo va en el header.
 */
export function createSender(options: SenderOptions): Sender {
  const url = new URL(TELEMETRY_BATCHES_PATH, options.gatewayUrl).toString();
  return {
    async send({ token, points, correlationId, sentAt }) {
      const started = options.nowMs();
      const elapsed = (): number => Math.round(options.nowMs() - started);
      let response: Response;
      try {
        response = await options.fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
            "x-correlation-id": correlationId,
          },
          body: JSON.stringify({ schemaVersion: 1, sentAt: sentAt.toISOString(), points }),
          signal: AbortSignal.timeout(options.timeoutMs),
        });
      } catch {
        // Red caída o timeout. Sin el error: puede traer la URL y nada de lo que importa.
        return { kind: "retry", status: null, latencyMs: elapsed() };
      }

      if (response.status === 202) {
        try {
          const ack = batchAckTolerantSchema.parse(await response.json());
          return { kind: "acked", ack, latencyMs: elapsed() };
        } catch {
          return { kind: "retry", status: 202, latencyMs: elapsed() };
        }
      }
      // Se descarta el cuerpo para liberar la conexión.
      await response.arrayBuffer().catch(() => undefined);
      if (response.status === 429 || response.status >= 500) return { kind: "retry", status: response.status, latencyMs: elapsed() };
      return { kind: "permanent", status: response.status, latencyMs: elapsed() };
    },
  };
}
