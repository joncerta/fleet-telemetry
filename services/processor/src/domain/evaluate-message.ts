import {
  TELEMETRY_RETENTION_DAYS,
  telemetryDlqMessageSchema,
  telemetryRawEventSchema,
  type TelemetryDlqMessage,
  type TelemetryRawEvent,
} from "@fleet/contracts";
import { z } from "zod";
import { isInsideOperatingArea } from "./operating-area.js";

/** Valor JSON del mensaje original, tal como lo exige el contrato de la DLQ (`originalPayload`). */
export type OriginalPayload = TelemetryDlqMessage["originalPayload"];

/** Identificadores que se pudieron leer del mensaje (cada uno solo si es un uuid). Van a la DLQ y a los logs. */
export interface KnownIds {
  readonly tenantId: string | null;
  readonly deviceId: string | null;
  readonly vehicleId: string | null;
  readonly eventId: string | null;
}

/** Códigos con los que el dominio rechaza un mensaje, sin reintentos. `processing_failed` lo decide el caso de uso. */
export type MessageRejectionCode = "invalid_schema" | "stale_timestamp" | "outside_operating_area";

/**
 * Antigüedad máxima de `recordedAt`: la retención de `telemetry` (90 días, migración 004). Es una defensa en profundidad con
 * una cota MÁS LAXA a propósito que la del gateway (`INGEST_GATEWAY_MAX_AGE_MS`, 7 días por defecto): el gateway pudo aceptar
 * un punto válido que espere días en Kafka si el processor estuvo caído, y rechazarlo con la cota del gateway sería perder
 * datos que ya se confirmaron al móvil. Solo se rechaza lo que el job de retención borraría en su siguiente pasada.
 */
export const MAX_POINT_AGE_MS = TELEMETRY_RETENTION_DAYS * 86_400_000;

/** `schemaVersion` de `telemetryRawEventSchema` que este consumer conoce. Una mayor no es un mensaje malo: ver `unsupported_version`. */
export const SUPPORTED_SCHEMA_VERSION = 1;

export interface MessageRules {
  /** Hora del servidor. Entra como argumento: el dominio no lee el reloj. */
  readonly now: Date;
}

export type MessageVerdict =
  | {
      readonly kind: "valid";
      readonly event: TelemetryRawEvent;
      /** El mensaje tal como llegó (JSON), para la DLQ si más tarde falla la persistencia. */
      readonly original: OriginalPayload;
      readonly ids: KnownIds;
    }
  | {
      /**
       * `schemaVersion` entera mayor que `SUPPORTED_SCHEMA_VERSION`: un productor se desplegó antes que este consumer. NO es un
       * fallo del contenido (regla 7) y por eso no es `rejected`: no va a la DLQ, el caso de uso detiene la partición hasta
       * desplegar la versión nueva y nada se pierde. Sin original ni ids: no se publica en ningún lado.
       */
      readonly kind: "unsupported_version";
      readonly version: number;
    }
  | {
      readonly kind: "rejected";
      readonly code: MessageRejectionCode;
      /** Legible y SIN datos personales: nombres de campo, nunca valores ni coordenadas. */
      readonly detail: string;
      readonly original: OriginalPayload;
      readonly ids: KnownIds;
    };

const MAX_REPORTED_FIELDS = 10;
const uuid = z.uuid();
const jsonValue = telemetryDlqMessageSchema.shape.originalPayload;

const NO_IDS: KnownIds = { tenantId: null, deviceId: null, vehicleId: null, eventId: null };

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined;

const uuidOrNull = (value: unknown): string | null => {
  const parsed = uuid.safeParse(value);
  return parsed.success ? parsed.data : null;
};

/** Ids del mensaje crudo: `tenantId` y `deviceId` en la raíz; `eventId` y `vehicleId` dentro de `point`. */
function readIds(raw: unknown): KnownIds {
  const root = asRecord(raw);
  if (root === undefined) return NO_IDS;
  const point = asRecord(root.point);
  return {
    tenantId: uuidOrNull(root.tenantId),
    deviceId: uuidOrNull(root.deviceId),
    vehicleId: uuidOrNull(point?.vehicleId),
    eventId: uuidOrNull(point?.eventId),
  };
}

/** Nombres de los campos que fallaron (sin valores ni mensajes de zod, que podrían citar datos del punto). */
function failedFields(issues: readonly z.core.$ZodIssue[]): string {
  const names = [...new Set(issues.map((issue) => (issue.path.length === 0 ? "(raíz)" : issue.path.map(String).join("."))))];
  const shown = names.slice(0, MAX_REPORTED_FIELDS).join(", ");
  return names.length > MAX_REPORTED_FIELDS ? `${shown} y ${names.length - MAX_REPORTED_FIELDS} más` : shown;
}

/**
 * Evalúa el valor de un mensaje de `telemetry.raw`, en este orden (el primero que falle es el motivo):
 * 0. `unsupported_version` (no es un rechazo): el valor es JSON con una `schemaVersion` entera mayor que la conocida;
 * 1. `invalid_schema`: el valor falta (tombstone), no es JSON, o no cumple `telemetryRawEventSchema`;
 * 2. `stale_timestamp`: `recordedAt` es anterior a `now - MAX_POINT_AGE_MS` (cota inclusiva: exactamente 90 días se acepta);
 * 3. `outside_operating_area`: el punto cae fuera del área de operación (ver `COLOMBIA_BBOX`).
 *
 * Ninguno se reintenta: el mismo mensaje daría el mismo veredicto. La hora futura no se mira aquí: es del gateway.
 *
 * `original` es lo que llegó, no lo que zod devuelve (que descarta campos desconocidos): si el valor era JSON, el valor
 * parseado; si no, el texto tal cual; si no hay valor, `null`. Es un dato personal: va a la DLQ, nunca a un log.
 */
export function evaluateMessage(value: string | null, rules: MessageRules): MessageVerdict {
  if (value === null) {
    return { kind: "rejected", code: "invalid_schema", detail: "El mensaje no tiene valor.", original: null, ids: NO_IDS };
  }

  const notJson: MessageVerdict = {
    kind: "rejected",
    code: "invalid_schema",
    detail: "El valor del mensaje no es JSON.",
    original: value,
    ids: NO_IDS,
  };
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(value);
  } catch {
    return notJson;
  }
  // Salió de JSON.parse, así que ya es JSON; el contrato de la DLQ lo exige de todos modos y se comprueba con su mismo
  // esquema en vez de afirmarlo con un cast.
  const checked = jsonValue.safeParse(parsedJson);
  if (!checked.success) return notJson;
  const original = checked.data;

  const declaredVersion = asRecord(original)?.schemaVersion;
  if (typeof declaredVersion === "number" && Number.isSafeInteger(declaredVersion) && declaredVersion > SUPPORTED_SCHEMA_VERSION) {
    return { kind: "unsupported_version", version: declaredVersion };
  }

  const parsed = telemetryRawEventSchema.safeParse(original);
  if (!parsed.success) {
    const detail = asRecord(original) === undefined ? "El mensaje no es un objeto." : `Campos inválidos: ${failedFields(parsed.error.issues)}.`;
    return { kind: "rejected", code: "invalid_schema", detail, original, ids: readIds(original) };
  }

  const event = parsed.data;
  const ids = readIds(original);
  if (Date.parse(event.point.recordedAt) < rules.now.getTime() - MAX_POINT_AGE_MS) {
    return { kind: "rejected", code: "stale_timestamp", detail: "recordedAt supera la antigüedad máxima (la retención).", original, ids };
  }
  if (!isInsideOperatingArea(event.point.lon, event.point.lat)) {
    return { kind: "rejected", code: "outside_operating_area", detail: "El punto está fuera del área de operación.", original, ids };
  }
  return { kind: "valid", event, original, ids };
}
