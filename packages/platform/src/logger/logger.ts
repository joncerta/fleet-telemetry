import { pino, type DestinationStream, type Logger } from "pino";
import type { LogLevel } from "../config/fragments.js";

export type { Logger } from "pino";

export const REDACTED = "[REDACTED]";

/** Profundidad máxima que recorre la redacción. Por debajo, el subárbol se descarta (falla cerrado). */
export const MAX_REDACTION_DEPTH = 8;
export const TRUNCATED = "[TRUNCATED]";

/** Compara sin distinguir mayúsculas ni separadores: `driverName`, `DriverName`, `driver_name` y `driver-name` son la misma clave. */
const normalizeKey = (key: string): string => key.toLowerCase().replaceAll(/[_-]/g, "");

const DRIVER_FIELDS = ["", "id", "name", "document", "phone", "email", "license"] as const;

/**
 * Claves cuyo valor es un dato personal (regla 14 de CLAUDE.md, Ley 1581): posición, geometrías, placa,
 * dirección y conductor. Están normalizadas con `normalizeKey`.
 */
export const REDACTED_KEYS: ReadonlySet<string> = new Set([
  "lat",
  "lon",
  "lng",
  "long",
  "latitude",
  "longitude",
  "position",
  "location",
  "coordinates",
  "coords",
  "geom",
  "geometry",
  "point",
  "wkt",
  "geojson",
  "plate",
  "licenseplate",
  "placa",
  "address",
  "direccion",
  // Alias del vehículo y datos de las personas del catálogo (nombre, correo): red de seguridad, nunca se registran a propósito.
  "label",
  "name",
  "email",
  ...["driver", "conductor"].flatMap((prefix) => DRIVER_FIELDS.map((field) => `${prefix}${field}`)),
]);

/**
 * Palabras de cada clave de `REDACTED_KEYS`. De aquí salen las grafías de `REDACT_PATHS`: `redact.paths` de pino
 * compara por nombre exacto, así que cada clave se expande a camelCase, PascalCase, snake_case, kebab-case, etc.
 */
const KEY_WORDS: readonly (readonly string[])[] = [
  ...["lat", "lon", "lng", "long", "latitude", "longitude", "position", "location", "coordinates", "coords", "geom", "geometry", "point", "wkt", "plate", "placa", "address", "direccion", "label", "name", "email"].map(
    (word) => [word],
  ),
  ["geo", "json"],
  ["geojson"],
  ["license", "plate"],
  ...["driver", "conductor"].flatMap((prefix) => DRIVER_FIELDS.map((field) => (field === "" ? [prefix] : [prefix, field]))),
];

const capitalize = (word: string): string => `${word.charAt(0).toUpperCase()}${word.slice(1)}`;

/** Grafías de una clave de varias palabras. */
function spellings(words: readonly string[]): string[] {
  const [first = "", ...rest] = words;
  return [
    [first, ...rest.map(capitalize)].join(""), // camelCase
    words.map(capitalize).join(""), // PascalCase
    words.join(""), // minúsculas pegadas
    words.join("").toUpperCase(),
    words.join("_"),
    words.join("_").toUpperCase(),
    words.join("-"),
    words.join("-").toUpperCase(),
  ];
}

/** Camino de pino para una clave: la notación con corchetes sirve para cualquier nombre (`driver-name`). */
const redactPath = (key: string): string => `["${key}"]`;

/**
 * Segunda red de seguridad: `redact.paths` de pino, con cada clave sensible en el primer nivel y en el siguiente
 * (`*["clave"]`). A diferencia de `formatters.log`, pino la aplica también a las propiedades de `logger.child({...})`
 * (comprobado en `logger.test.ts` con la versión instalada).
 */
export const REDACT_PATHS: readonly string[] = [
  ...new Set(KEY_WORDS.flatMap(spellings)),
].flatMap((key) => [redactPath(key), `*${redactPath(key)}`]);

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/** Propiedades de un error de `pg` (`DatabaseError`) que citan datos: la fila ("Failing row contains (...)"), el SQL y su contexto. */
const SENSITIVE_ERROR_PROPS: ReadonlySet<string> = new Set(["detail", "where", "internalQuery", "hint"]);
const MAX_ERROR_DEPTH = 5;

const isErrorLike = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && "message" in value && "stack" in value;

/** Copia `serialized` sin las propiedades sensibles y hace lo mismo con los errores anidados (`aggregateErrors`, propiedades). */
function scrubError(serialized: Record<string, unknown>, depth: number): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(serialized)) {
    if (SENSITIVE_ERROR_PROPS.has(key)) continue;
    result[key] = scrubNested(value, depth + 1);
  }
  return result;
}

function scrubNested(value: unknown, depth: number): unknown {
  if (Array.isArray(value)) {
    return depth >= MAX_ERROR_DEPTH ? TRUNCATED : value.map((item: unknown) => scrubNested(item, depth + 1));
  }
  if (isErrorLike(value)) return depth >= MAX_ERROR_DEPTH ? TRUNCATED : scrubError(value, depth);
  return value;
}

/**
 * Serializador de `err`: parte del estándar de pino (`stdSerializers.err`: tipo, mensaje con sus causas, stack y
 * propiedades, p. ej. `code`) y quita `detail`, `where`, `internalQuery` y `hint`, que `pg` rellena con la fila o el
 * SQL. Recorre errores anidados (`aggregateErrors`, propiedades que son errores). El estándar no copia las propiedades
 * de `cause` (solo su mensaje y su stack), pero si un día lo hiciera, `scrubError` también las limpiaría.
 * Un `err` que no es un `Error` pero sí un objeto plano se limpia igual (sin las cuatro propiedades).
 */
export function serializeError(err: unknown): unknown {
  if (err instanceof Error) return scrubError({ ...pino.stdSerializers.err(err) }, 0);
  if (isPlainObject(err)) return scrubError(err, 0);
  return err;
}

/** Destino de una URL sin lo que puede ser personal: credenciales, query (`?lat=...`) y fragmento. */
const describeUrl = (url: URL): string => `${url.protocol}//${url.host}${url.pathname}`;

const isBinary = (value: unknown): value is ArrayBufferView | ArrayBuffer | SharedArrayBuffer =>
  ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof SharedArrayBuffer;

function redactEntries(object: object, depth: number): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(object)) {
    result[key] = REDACTED_KEYS.has(normalizeKey(key)) ? REDACTED : redactDeep(item, depth + 1);
  }
  return result;
}

/**
 * Copia `value` reemplazando por `[REDACTED]` el valor de toda clave de `REDACTED_KEYS`, a cualquier profundidad
 * hasta `MAX_REDACTION_DEPTH` y atravesando arreglos (`{ batch: { points: [{ lat, lon }] } }`). Más abajo de ese
 * límite el subárbol se sustituye por `[TRUNCATED]`: es preferible perder detalle a filtrar un dato personal.
 * Recorre objetos planos y arreglos. Normaliza lo que `JSON.stringify` o pino no saben escribir sin filtrar o sin romperse:
 * - todo `Error`, bajo cualquier clave y a cualquier profundidad, pasa por `serializeError` (un `DatabaseError` de `pg`
 *   trae la fila en `detail`); es idempotente con `serializers.err`;
 * - un `URL` se escribe como `protocolo//host/ruta`, sin credenciales, query ni fragmento (la query puede traer la posición);
 * - un `ArrayBuffer`, `SharedArrayBuffer` o vista (`Buffer`, `Uint8Array`, `DataView`) se escribe como `[binary N bytes]`.
 * Los demás objetos (`Date`, `Map`...) pasan tal cual a pino.
 *
 * **Lo que NO cubre** (la redacción es la última red de seguridad, no un permiso para loguear datos):
 * - claves con otro nombre (`gpsLat`, `fix.y`, `nombre`, `vin`...);
 * - objetos que no son planos ni arreglos y no se normalizan arriba (instancias de clase, `Map`, `Set`, `Headers`) y las
 *   propiedades de un `Error` que no sean las cuatro que quita `serializeError`;
 * - los mismos datos dentro de un texto: el `message`, un `err.message`, una URL o un `JSON.stringify`;
 * - cualquier dato personal que no esté bajo una clave de `REDACTED_KEYS` (por ejemplo, un WKT dentro de un campo `value`);
 * - las propiedades de `logger.child({...})`: `formatters.log` no las ve. Las cubre solo la segunda red,
 *   `redact.paths` de pino (ver `REDACT_PATHS`), que es por nombre exacto (no ignora mayúsculas ni separadores
 *   más allá de las grafías de `SPELLINGS`) y solo mira el primer nivel y uno más (`*.clave`). Para el contexto usa
 *   `withContext`, que solo admite `correlationId`, `tenantId` y `vehicleId`;
 * - lo que quede a más de `MAX_REDACTION_DEPTH` niveles (se descarta entero).
 * La regla de fondo sigue siendo no loguear payloads de telemetría ni objetos de conductor.
 */
export function redactDeep(value: unknown, depth = 0): unknown {
  if (value instanceof Error) return serializeError(value);
  if (value instanceof URL) return describeUrl(value);
  if (isBinary(value)) return `[binary ${value.byteLength} bytes]`;
  if (Array.isArray(value)) {
    if (depth >= MAX_REDACTION_DEPTH) return TRUNCATED;
    return value.map((item: unknown) => redactDeep(item, depth + 1));
  }
  if (isPlainObject(value)) {
    return depth >= MAX_REDACTION_DEPTH ? TRUNCATED : redactEntries(value, depth);
  }
  return value;
}

/** El objeto de primer nivel de cada llamada al logger: se recorre aunque no sea plano (el nivel raíz no se salta). */
const redactObject = (object: object): Record<string, unknown> => redactEntries(object, 0);

export interface CreateLoggerOptions {
  /** Nombre del servicio; sale en todas las líneas. */
  service: string;
  level?: LogLevel;
  /** Destino de las líneas JSON. Por defecto, la salida estándar. */
  destination?: DestinationStream;
}

/** Logger pino estructurado (JSON, una línea por evento) con redacción de datos personales y errores sin `detail` de `pg`. */
export function createLogger({ service, level = "info", destination }: CreateLoggerOptions): Logger {
  return pino(
    {
      level,
      base: { service },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level: (label) => ({ level: label }),
        // Lo que se loguea en cada llamada. Las propiedades de `logger.child({...})` no pasan por aquí (ver la nota de redactDeep).
        log: redactObject,
      },
      // `err` y `error`: el estándar de pino solo trata `err`, y un `DatabaseError` de `pg` en `error` llevaría su `detail`.
      serializers: { err: serializeError, error: serializeError },
      // Segunda red: cubre las propiedades de `logger.child({...})`, que `formatters.log` no ve.
      redact: { paths: [...REDACT_PATHS], censor: REDACTED },
    },
    destination,
  );
}

/** Contexto de correlación que acompaña a todas las líneas de un request o de un mensaje. */
export interface LogContext {
  correlationId?: string | undefined;
  tenantId?: string | undefined;
  vehicleId?: string | undefined;
}

/** Logger hijo con `correlationId`, `tenantId` y `vehicleId` (regla 16). Las claves sin valor se omiten. */
export function withContext(logger: Logger, context: LogContext): Logger {
  const bindings: Record<string, string> = {};
  if (context.correlationId !== undefined) bindings.correlationId = context.correlationId;
  if (context.tenantId !== undefined) bindings.tenantId = context.tenantId;
  if (context.vehicleId !== undefined) bindings.vehicleId = context.vehicleId;
  return logger.child(bindings);
}
