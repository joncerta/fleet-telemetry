import type { TelemetryPoint } from "@fleet/contracts";
import { evaluatePoint, type PointRejection, type PointRules } from "./evaluate-point.js";

export interface RejectedEntry extends PointRejection {
  /** Posición del punto en el lote, desde 0. */
  readonly index: number;
}

export interface BatchEvaluation {
  /** Puntos válidos y únicos dentro del lote, en el orden en que llegaron. */
  readonly valid: readonly TelemetryPoint[];
  readonly rejected: readonly RejectedEntry[];
}

/**
 * Evalúa todos los puntos de un lote. Un `eventId` repetido entre los válidos se conserva una sola vez (el primero) y
 * los demás se descartan sin rechazo: el reenvío de un mismo punto es normal (la cola offline del móvil), no un error.
 * NO se comparan los payloads de los duplicados: si dos puntos con el mismo `eventId` difieren, gana el primero y el
 * conflicto no se detecta (el `eventId` lo genera el dispositivo una vez por punto, así que solo ocurre por un bug suyo).
 * Un punto inválido nunca cuenta como duplicado: cada uno se rechaza por su índice.
 */
export function evaluateBatch(points: readonly unknown[], rules: PointRules): BatchEvaluation {
  const valid: TelemetryPoint[] = [];
  const rejected: RejectedEntry[] = [];
  const seen = new Set<string>();

  points.forEach((raw, index) => {
    const verdict = evaluatePoint(raw, rules);
    if (!verdict.accepted) {
      rejected.push({ index, ...verdict.rejection });
      return;
    }
    const key = verdict.point.eventId.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    valid.push(verdict.point);
  });

  return { valid, rejected };
}
