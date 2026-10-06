import { z } from "zod";

/**
 * Contratos de la ingesta de telemetría (todo es v1).
 *
 * Versionado: nada de esto se ha publicado a un consumidor real (el móvil no existe todavía), así que `future_timestamp`
 * y `stale_timestamp` (motivos de rechazo y códigos de la DLQ), `schemaVersion` del ACK y `truncatedFromBytes` de la DLQ
 * forman parte de la v1 del cable: un solo fixture v1 por esquema. **Desde que exista un consumidor real (el móvil
 * publicado, o un mensaje retenido que otro servicio lea), un motivo o código nuevo implica una versión nueva**
 * (`/add-contract`): los enums estrictos rechazan lo que no conocen y las variantes tolerantes lo leen como `"unknown"`.
 *
 * Versiones: las variantes ESTRICTAS (`telemetryRawEventSchema`, `batchAckSchema`, `telemetryDlqMessageSchema`) solo aceptan
 * `schemaVersion: 1`; las TOLERANTES (para quien lee lo que otro produjo y no puede reintentar) aceptan cualquier entero >= 1.
 * Regla de despliegue: **los consumers se despliegan antes que los productores** (ADR-005.14): un productor que emita una
 * versión nueva solo sale cuando todos sus consumers ya la leen.
 *
 * Los mensajes externos usan `z.object` (descarta campos desconocidos), nunca `z.strictObject`: una versión más
 * nueva de un productor puede agregar campos. Restringir una cota o agregar un valor a un enum es un cambio
 * incompatible (ver `/add-contract`).
 *
 * Privacidad (Ley 1581): `lon`, `lat` y, en general, todo el punto son datos personales. No van a logs ni a
 * mensajes de error (`detail`, `reason.message`).
 */

/** Máximo de puntos por lote (HTTP). Un lote mayor es un envelope roto: `400`. Desde v1. */
export const MAX_BATCH_POINTS = 500;

/** Prefijo del token de dispositivo. Permite que un escáner de secretos lo detecte. Desde v1. */
export const DEVICE_TOKEN_PREFIX = "fdt_";

/**
 * Retención de `telemetry` en días (migración 004). Es la cota máxima de antigüedad de un punto: el gateway no acepta
 * más de esto (`INGEST_GATEWAY_MAX_AGE_MS`) y el processor rechaza lo que la supera. Desde v1.
 */
export const TELEMETRY_RETENTION_DAYS = 90;

/**
 * Motivos por los que el gateway rechaza un punto. Agregar uno rompe a los consumidores estrictos.
 * - `future_timestamp`: `recordedAt` supera la hora del servidor más la tolerancia configurada del gateway.
 * - `stale_timestamp`: `recordedAt` es anterior a la hora del servidor menos la antigüedad máxima configurada del
 *   gateway (por defecto 7 días, como mucho `TELEMETRY_RETENTION_DAYS`).
 * Un punto que supera el tamaño máximo serializado se rechaza como `invalid_schema`.
 */
const REJECT_REASONS = ["invalid_schema", "vehicle_mismatch", "future_timestamp", "stale_timestamp"] as const;

/**
 * Códigos con los que un mensaje llega a `telemetry.dlq`. Agregar uno rompe a los consumidores estrictos.
 * `future_timestamp` y `stale_timestamp`: igual que en `REJECT_REASONS`. El processor también usa `stale_timestamp`, pero
 * con otra cota: solo lo que supera `TELEMETRY_RETENTION_DAYS`, para no perder lo que el gateway aceptó y esperó en Kafka.
 */
const DLQ_CODES = [
  "invalid_schema",
  "vehicle_mismatch",
  "future_timestamp",
  "stale_timestamp",
  "outside_operating_area",
  "processing_failed",
] as const;

const UNKNOWN_VALUE = "unknown";

const datetime = (description: string) => z.iso.datetime({ offset: true }).describe(description);

/**
 * Un punto de telemetría tal como lo captura el dispositivo. Desde v1.
 *
 * El bbox de Colombia no se valida aquí: es una regla de dominio del processor.
 */
export const telemetryPointSchema = z.object({
  eventId: z
    .uuid()
    .describe(
      "Identificador del punto. Lo genera el dispositivo al capturarlo y es la llave de idempotencia de punta a punta. Desde v1.",
    ),
  vehicleId: z
    .uuid()
    .describe("Vehículo que reporta. El gateway lo compara con el vehículo del token y no confía en él. Desde v1."),
  recordedAt: datetime(
    "Hora del fix GPS del dispositivo, ISO 8601 con offset obligatorio; el consumidor la normaliza a UTC. Desde v1.",
  ),
  lon: z
    .number()
    .finite()
    .min(-180)
    .max(180)
    .describe("DATO PERSONAL (Ley 1581). Longitud en grados WGS84 (SRID 4326), de -180 a 180. Desde v1."),
  lat: z
    .number()
    .finite()
    .min(-90)
    .max(90)
    .describe("DATO PERSONAL (Ley 1581). Latitud en grados WGS84 (SRID 4326), de -90 a 90. Desde v1."),
  speedMps: z
    .number()
    .finite()
    .min(0)
    .max(150)
    .nullable()
    .describe("Velocidad en metros por segundo (0 a 150), o null si el GPS no la entrega. Desde v1."),
  headingDeg: z
    .number()
    .finite()
    .min(0)
    .lt(360)
    .nullable()
    .describe("Rumbo en grados desde el norte, de 0 a menos de 360, o null. Desde v1."),
  accuracyM: z
    .number()
    .finite()
    .gt(0)
    .nullable()
    .describe("Radio de precisión horizontal en metros (> 0), o null si el GPS no lo entrega. Desde v1."),
  altitudeM: z
    .number()
    .finite()
    .nullable()
    .optional()
    .describe("Altitud en metros sobre el nivel del mar. Opcional y nullable. Desde v1."),
  mocked: z
    .boolean()
    .describe("El sistema operativo indica que la ubicación viene de un proveedor simulado. Desde v1."),
  lowAccuracy: z
    .boolean()
    .describe("Lo calcula el dispositivo con su propio umbral de precisión. Desde v1."),
});
export type TelemetryPoint = z.infer<typeof telemetryPointSchema>;

/**
 * Body HTTP del lote (`POST` al gateway). Desde v1.
 *
 * `points` es `unknown` a propósito: un envelope roto (JSON inválido, sin esta estructura, lote vacío o de más de
 * `MAX_BATCH_POINTS`) da `400` sin pasar por la DLQ; cada punto se valida por separado contra
 * `telemetryPointSchema`, y los inválidos van a `rejected` del ACK y a `telemetry.dlq`.
 */
export const telemetryBatchEnvelopeSchema = z.object({
  schemaVersion: z.literal(1).describe("Versión del envelope. Desde v1."),
  sentAt: datetime("Reloj del dispositivo al enviar el lote, para diagnosticar desfases. Desde v1."),
  points: z
    .array(z.unknown())
    .min(1)
    .max(MAX_BATCH_POINTS)
    .describe(`De 1 a ${MAX_BATCH_POINTS} puntos, sin validar aquí: cada uno se valida contra telemetryPointSchema. Desde v1.`),
});
export type TelemetryBatchEnvelope = z.infer<typeof telemetryBatchEnvelopeSchema>;

/**
 * Valor del mensaje en el tópico `telemetry.raw`. Desde v1.
 *
 * La key del mensaje Kafka es `point.vehicleId` y el `correlationId` viaja en los headers (lo gestiona
 * `@fleet/platform`), no en el valor. `point` va anidado para separar lo que dijo el dispositivo de lo que agregó
 * el servidor. `tenantId` y `deviceId` salen del token, nunca del payload del dispositivo.
 */
export const telemetryRawEventSchema = z.object({
  schemaVersion: z.literal(1).describe("Versión del evento. Desde v1."),
  tenantId: z.uuid().describe("Tenant dueño del dato, tomado del token verificado. Desde v1."),
  deviceId: z.uuid().describe("Dispositivo autenticado que envió el punto, tomado del token. Desde v1."),
  receivedAt: datetime("Hora del servidor (gateway) al recibir el punto. Desde v1."),
  point: telemetryPointSchema.describe("Punto tal como lo envió el dispositivo. Desde v1."),
});
export type TelemetryRawEvent = z.infer<typeof telemetryRawEventSchema>;

function rejectedPointOf<R extends z.ZodType>(reason: R) {
  return z.object({
    index: z.number().int().min(0).describe("Posición del punto en el lote, desde 0. Desde v1."),
    eventId: z
      .uuid()
      .nullable()
      .describe("eventId del punto rechazado, o null si falta o no es un uuid. Desde v1."),
    reason: reason.describe("Motivo del rechazo. Desde v1."),
    detail: z
      .string()
      .optional()
      .describe("Detalle legible del rechazo. Nunca lleva datos personales (coordenadas, conductor). Desde v1."),
  });
}

const strictReason = z.enum(REJECT_REASONS);
const tolerantReason = z.enum([...REJECT_REASONS, UNKNOWN_VALUE]).catch(UNKNOWN_VALUE);

/**
 * Versión del cable de un mensaje que se PRODUCE (estricta, solo la 1) o se CONSUME fuera del servicio que lo emite
 * (tolerante: cualquier entero >= 1). La tolerante deja que un cliente viejo (el móvil, k6, QA) lea un ACK o un mensaje de la
 * DLQ de una versión posterior en vez de rechazarlo; en el ACK, rechazarlo haría reintentar el lote para siempre.
 */
const strictVersion = z.literal(1);
const tolerantVersion = z.number().int().min(1);

function batchAckOf<R extends z.ZodType, V extends z.ZodType>(reason: R, version: V) {
  return z.object({
    schemaVersion: version.describe("Versión del ACK. Desde v1."),
    accepted: z
      .array(z.uuid())
      .describe(
        "eventId aceptados por el gateway, es decir publicados en Kafka, no necesariamente persistidos. Un reenvío de " +
          "puntos ya persistidos vuelve aquí; si no, el móvil los reintentaría para siempre. Desde v1.",
      ),
    rejected: z
      .array(rejectedPointOf(reason))
      .describe("Puntos rechazados. Un rechazo es permanente: el móvil no lo reintenta. Desde v1."),
    serverTime: datetime("Hora del servidor al responder. Desde v1."),
  });
}

/**
 * Respuesta `202` del gateway para un lote. Variante ESTRICTA, para el productor (el gateway): solo emite los
 * motivos conocidos. Desde v1.
 */
export const batchAckSchema = batchAckOf(strictReason, strictVersion);
export type BatchAck = z.infer<typeof batchAckSchema>;
export type RejectedPoint = BatchAck["rejected"][number];
export type RejectReason = RejectedPoint["reason"];

/**
 * Misma respuesta, variante TOLERANTE, para consumidores (el móvil): un motivo que esta versión no conoce se lee
 * como `"unknown"` en vez de fallar, y una `schemaVersion` mayor que 1 también se lee. Un `rejected` con `"unknown"` sigue
 * siendo permanente. Desde v1.
 */
export const batchAckTolerantSchema = batchAckOf(tolerantReason, tolerantVersion);
export type BatchAckTolerant = z.infer<typeof batchAckTolerantSchema>;

function dlqMessageOf<C extends z.ZodType, V extends z.ZodType>(code: C, version: V) {
  const nullableUuid = (description: string) => z.uuid().nullable().describe(description);
  return z.object({
    schemaVersion: version.describe("Versión del mensaje. Desde v1."),
    source: z.enum(["ingest-gateway", "processor"]).describe("Servicio que envió el mensaje a la DLQ. Desde v1."),
    reason: z
      .object({
        code: code.describe("Código del fallo. Desde v1."),
        message: z.string().describe("Descripción del fallo. Sin datos personales. Desde v1."),
      })
      .describe("Motivo por el que el mensaje está en la DLQ. Desde v1."),
    failedAt: datetime("Hora del servidor en que falló. Desde v1."),
    tenantId: nullableUuid("Tenant, o null si no se sabe. Desde v1."),
    deviceId: nullableUuid("Dispositivo, o null si no se sabe. Desde v1."),
    vehicleId: nullableUuid("Vehículo, o null si no se sabe. Desde v1."),
    eventId: nullableUuid("eventId del punto, o null si no se sabe. Desde v1."),
    attempts: z.number().int().min(0).describe("Reintentos del processor antes de enviarlo a la DLQ; 0 en el gateway. Desde v1."),
    originalPayload: z
      .json()
      .describe(
        "DATO PERSONAL. Requerido: el punto tal como llegó o el valor original del mensaje de Kafka; si no era JSON, el string. " +
          "Cualquier valor JSON es válido (incluido null), pero la propiedad no puede omitirse ni ser undefined. " +
          "Si `truncatedFromBytes` está presente, es solo el INICIO (un string) del JSON serializado del punto. Desde v1.",
      ),
    truncatedFromBytes: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "Solo si el punto superó el tamaño máximo del gateway: su tamaño original en bytes UTF-8, serializado. " +
          "`originalPayload` es entonces solo su inicio, para que el mensaje de la DLQ siempre quepa en un lote de Kafka. " +
          "Ausente si `originalPayload` está completo. Desde v1.",
      ),
  });
}

/**
 * Valor del mensaje en `telemetry.dlq`. Variante ESTRICTA, para productores (gateway y processor). Desde v1.
 *
 * `originalPayload` conserva las coordenadas originales: la DLQ es un almacén de datos personales con retención
 * (14 días), no un log. Nunca se vuelca a logs ni a reportes de error.
 */
export const telemetryDlqMessageSchema = dlqMessageOf(z.enum(DLQ_CODES), strictVersion);
export type TelemetryDlqMessage = z.infer<typeof telemetryDlqMessageSchema>;
export type DlqCode = TelemetryDlqMessage["reason"]["code"];

/**
 * Misma estructura, variante TOLERANTE para consumidores (k6, QA): un código nuevo se lee como `"unknown"` y una
 * `schemaVersion` mayor que 1 también se lee. Desde v1.
 */
export const telemetryDlqMessageTolerantSchema = dlqMessageOf(z.enum([...DLQ_CODES, UNKNOWN_VALUE]).catch(UNKNOWN_VALUE), tolerantVersion);
export type TelemetryDlqMessageTolerant = z.infer<typeof telemetryDlqMessageTolerantSchema>;

/**
 * Token de dispositivo: string opaco `fdt_` + 32 bytes aleatorios en base64url sin relleno (43 caracteres). Desde v1.
 *
 * Viaja en `Authorization: Bearer`. El servidor solo guarda su hash. Este esquema valida solo el formato: la
 * emisión y la verificación son del gateway. Nunca se registra en logs.
 */
export const deviceTokenSchema = z
  .string()
  .regex(new RegExp(`^${DEVICE_TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`), {
    error: "formato de token de dispositivo inválido",
  })
  .describe("Token opaco `fdt_` + 43 caracteres base64url. Desde v1.");
export type DeviceToken = z.infer<typeof deviceTokenSchema>;

/**
 * Cuerpo de las respuestas HTTP `4xx` y `5xx`. Desde v1.
 *
 * `code` es un string y no un enum para poder crecer sin romper clientes. El gateway usa: `invalid_envelope`,
 * `unauthorized`, `forbidden`, `payload_too_large`, `unsupported_media_type`, `rate_limited` y `service_unavailable`. `message` nunca lleva SQL, stack traces ni
 * datos personales.
 */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1).describe("Código estable legible por máquina. Desde v1."),
    message: z.string().describe("Mensaje para humanos. Sin SQL, stack ni datos personales. Desde v1."),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
