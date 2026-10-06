import { telemetryDlqMessageSchema, telemetryPointSchema, type RejectReason, type TelemetryPoint } from "@fleet/contracts";
import { z } from "zod";

/** Reglas con las que se evalúa cada punto de un lote. */
export interface PointRules {
  /** Vehículo del token: el único que el dispositivo puede reportar. */
  readonly vehicleId: string;
  /** Hora del servidor al recibir el lote. Entra como argumento: el dominio no lee el reloj. */
  readonly now: Date;
  /** Cuánto puede adelantarse `recordedAt` a `now` (desfase de reloj del dispositivo). */
  readonly futureToleranceMs: number;
  /**
   * Antigüedad máxima de `recordedAt` respecto de `now`. Sin cota hacia atrás, un dispositivo con token válido podría crear un
   * chunk de la hypertable por cada fecha distinta (degrada la base para todos los tenants) y se aceptaría lo que la
   * retención va a borrar. Como mucho la retención de `telemetry` (`TELEMETRY_RETENTION_DAYS`).
   */
  readonly maxAgeMs: number;
  /** Tamaño máximo, en bytes UTF-8 del JSON serializado, de UN punto. Más grande es `invalid_schema`. */
  readonly maxPointBytes: number;
}

/**
 * Largo (en caracteres) del inicio del punto que se guarda en la DLQ cuando el punto supera `maxPointBytes`. Es lo bastante
 * largo para identificar el punto (`eventId` y los primeros campos) y lo bastante corto para que el mensaje de la DLQ
 * siempre quepa en un lote de Kafka.
 */
export const ORIGINAL_PAYLOAD_PREVIEW_CHARS = 1_024;

/** Valor JSON del punto original, tal como lo exige el contrato de la DLQ (`originalPayload`). */
export type OriginalPayload = z.output<typeof telemetryDlqMessageSchema.shape.originalPayload>;

export interface PointRejection {
  readonly reason: RejectReason;
  /** Legible y SIN datos personales: nunca coordenadas ni valores del punto, solo nombres de campo. */
  readonly detail: string;
  /** `eventId` del punto si existe y es un uuid; `null` si no. */
  readonly eventId: string | null;
  /**
   * El punto tal como llegó, para la DLQ (es un dato personal: no va a logs). Si superó `maxPointBytes`, solo el INICIO de su
   * JSON serializado (un string de a lo sumo `ORIGINAL_PAYLOAD_PREVIEW_CHARS`).
   */
  readonly original: OriginalPayload;
  /** Solo si `original` está truncado: tamaño original del punto serializado, en bytes UTF-8. */
  readonly truncatedFromBytes?: number;
}

export type PointVerdict =
  | { readonly accepted: true; readonly point: TelemetryPoint }
  | { readonly accepted: false; readonly rejection: PointRejection };

const MAX_REPORTED_FIELDS = 10;
const uuid = z.uuid();
const jsonValue = telemetryDlqMessageSchema.shape.originalPayload;

const reject = (raw: unknown, reason: RejectReason, detail: string): PointVerdict => ({
  accepted: false,
  rejection: { reason, detail, eventId: knownEventId(raw), original: toJson(raw) },
});

/** `eventId` del valor crudo si es un objeto con un uuid en ese campo. */
function knownEventId(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null || !("eventId" in raw)) return null;
  const parsed = uuid.safeParse(raw.eventId);
  return parsed.success ? parsed.data : null;
}

/**
 * El punto llegó por `JSON.parse`, así que ya es JSON; el contrato de la DLQ lo exige de todos modos y aquí se
 * comprueba con su mismo esquema en vez de afirmarlo con un cast.
 */
function toJson(raw: unknown): OriginalPayload {
  const parsed = jsonValue.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Nombres de los campos que fallaron (sin valores ni mensajes de zod, que podrían citar datos del punto). */
function failedFields(issues: readonly z.core.$ZodIssue[]): string {
  const names = [...new Set(issues.map((issue) => (issue.path.length === 0 ? "(raíz)" : issue.path.map(String).join("."))))];
  const shown = names.slice(0, MAX_REPORTED_FIELDS).join(", ");
  return names.length > MAX_REPORTED_FIELDS ? `${shown} y ${names.length - MAX_REPORTED_FIELDS} más` : shown;
}

/**
 * Evalúa un punto del lote, en este orden (el primero que falle es el motivo):
 * 1. `invalid_schema`: su JSON serializado supera `maxPointBytes` (en la DLQ solo va el inicio, con su tamaño original),
 *    o no cumple `telemetryPointSchema`;
 * 2. `vehicle_mismatch`: su `vehicleId` no es el del token (se comparan sin distinguir mayúsculas: es un uuid);
 * 3. `future_timestamp`: `recordedAt` supera `now + futureToleranceMs` (cota inclusiva);
 * 4. `stale_timestamp`: `recordedAt` es anterior a `now - maxAgeMs` (cota inclusiva: justo en el límite se acepta).
 */
export function evaluatePoint(raw: unknown, rules: PointRules): PointVerdict {
  const serialized = JSON.stringify(raw) ?? "";
  const sizeBytes = utf8Length(serialized);
  if (sizeBytes > rules.maxPointBytes) return rejectOversized(raw, serialized, sizeBytes, rules.maxPointBytes);

  const parsed = telemetryPointSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? `Campos inválidos: ${failedFields(parsed.error.issues)}.` : "El punto no es un objeto.";
    return reject(raw, "invalid_schema", detail);
  }
  const point = parsed.data;
  if (point.vehicleId.toLowerCase() !== rules.vehicleId.toLowerCase()) {
    return reject(raw, "vehicle_mismatch", "El vehicleId del punto no es el del dispositivo autenticado.");
  }
  const recordedAtMs = Date.parse(point.recordedAt);
  if (Number.isNaN(recordedAtMs)) return reject(raw, "invalid_schema", "Campos inválidos: recordedAt.");
  if (recordedAtMs > rules.now.getTime() + rules.futureToleranceMs) {
    return reject(raw, "future_timestamp", "recordedAt supera la hora del servidor más la tolerancia permitida.");
  }
  if (recordedAtMs < rules.now.getTime() - rules.maxAgeMs) {
    return reject(raw, "stale_timestamp", "recordedAt es anterior a la antigüedad máxima permitida.");
  }
  return { accepted: true, point };
}

/** Bytes del texto en UTF-8 (el dominio no usa `Buffer`: es del entorno de Node). */
const utf8Length = (text: string): number => new TextEncoder().encode(text).length;

/** Punto demasiado grande: se rechaza SIN parsearlo con zod, y a la DLQ va solo el inicio de su JSON y su tamaño. */
function rejectOversized(raw: unknown, serialized: string, sizeBytes: number, maxPointBytes: number): PointVerdict {
  return {
    accepted: false,
    rejection: {
      reason: "invalid_schema",
      detail: `El punto supera el tamaño máximo permitido (${maxPointBytes} bytes).`,
      eventId: knownEventId(raw),
      original: previewOf(serialized),
      truncatedFromBytes: sizeBytes,
    },
  };
}

/** Los primeros `ORIGINAL_PAYLOAD_PREVIEW_CHARS` caracteres, sin partir un par sustituto (el string quedaría mal formado). */
function previewOf(serialized: string): string {
  const preview = serialized.slice(0, ORIGINAL_PAYLOAD_PREVIEW_CHARS);
  return preview.isWellFormed() ? preview : preview.slice(0, -1);
}
