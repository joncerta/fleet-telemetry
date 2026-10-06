import { z } from "zod";
import { DEVICE_TOKEN_PREFIX, deviceTokenSchema } from "./telemetry.js";

/**
 * Contratos del read model de la flota (fase 1b, todo es v1): estado de vehículo, alertas, zonas, resumen, vehículos detenidos,
 * eventos de Kafka (`vehicle.state` y `fleet.alerts`), eventos SSE, sesión y vinculación del dispositivo.
 *
 * Versionado y variantes. Nada de esto se ha publicado: todo es v1 y cada esquema tiene su fixture. Los enums que pueden crecer
 * (`movement`, `AlertType`, `ZoneKind`) tienen una variante ESTRICTA (la que usan los productores y las entradas HTTP, que solo
 * aceptan lo conocido) y una TOLERANTE (`...TolerantSchema`, para quien lee lo que otro produjo y no puede desplegarse en
 * orden: la web, el móvil): un valor que esta versión no conoce se lee como `"unknown"` en vez de fallar, y en los eventos de
 * Kafka una `schemaVersion` entera >= 1 también se lee. Agregar un valor a un enum es un cambio que rompe a las estrictas
 * (`/add-contract`). Los mensajes externos usan `z.object` (descarta campos desconocidos), nunca `z.strictObject`.
 *
 * Orden de los eventos (reglas 9 y de este contrato): cada actualización de un vehículo o de una alerta toma un `seq` de UNA
 * secuencia global de la base (`fleet_event_seq`), dentro de la misma transacción que la persiste. El `seq` es un bigint
 * serializado como string (un `number` de JavaScript pierde precisión pasados 2^53). Regla del cliente: **un evento de
 * vehículo se aplica solo si su `seq` supera al que ya se tiene de ese vehículo** (un evento de alerta, al de esa `alertId`);
 * si no, se descarta por viejo. Se compara con `compareSeq` / `isNewerSeq`, nunca como strings ni como `number`. Los eventos
 * de un mismo vehículo viajan por la misma partición (key = `vehicleId`), así que su orden de `seq` es el de procesamiento.
 *
 * Privacidad (Ley 1581): `lon`, `lat`, `plate` y todo el estado de un vehículo son datos personales. No van a logs.
 */

/** Hora a partir de la cual un vehículo se considera sin señal: `receivedAt` más viejo que esto contra la hora del servidor. */
export const NO_SIGNAL_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Valores de `movement`. El estado `no_signal` NO es uno de ellos ni lo produce el processor: lo deriva `fleet-api` al LEER
 * (y la web puede recalcularlo con `hasNoSignal` contra el `serverTime` del snapshot) cuando `receivedAt` tiene más de
 * `NO_SIGNAL_THRESHOLD_MS` contra la hora del servidor. Así un vehículo sin conexión no necesita un evento que lo marque.
 */
export const MOVEMENTS = ["moving", "stopped"] as const;
export const ALERT_TYPES = ["critical_zone_stop", "mocked_location"] as const;
export const ZONE_KINDS = ["critical", "depot", "customer"] as const;
export type Movement = (typeof MOVEMENTS)[number];
export type AlertType = (typeof ALERT_TYPES)[number];
export type ZoneKind = (typeof ZONE_KINDS)[number];

const UNKNOWN_VALUE = "unknown";

/** Eventos SSE del stream de `fleet-api`. El `event:` de cada uno; su `id:` es el `seq` del evento. */
export const SSE_EVENTS = { snapshot: "snapshot", vehicleState: "vehicle.state", alert: "alert" } as const;
/** Texto del comentario de heartbeat del stream (`: heartbeat`). No es un evento: no lleva `id:` ni `data:`. */
export const SSE_HEARTBEAT_COMMENT = "heartbeat";

/**
 * Alfabeto del código de vinculación: 32 símbolos (las letras sin `I` ni `O`, y los dígitos del 2 al 9: sin `0` ni `1`), para
 * que no se confundan al escribirlo a mano en el móvil. Mayúsculas: el cliente normaliza lo que teclea el usuario.
 */
export const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const PAIRING_CODE_LENGTH = 8;

/** Máximo de un bigint de Postgres (`bigint`): 2^63 - 1. */
const MAX_SEQ = 9_223_372_036_854_775_807n;

const datetime = (description: string) => z.iso.datetime({ offset: true }).describe(description);

const SEQ_PATTERN = /^(0|[1-9][0-9]{0,18})$/;

const seq = (description: string) =>
  z
    .string()
    .regex(SEQ_PATTERN, { error: "seq debe ser un entero sin signo, sin ceros a la izquierda" })
    // zod ejecuta todas las comprobaciones aunque la anterior falle: sin el patrón, `BigInt("abc")` lanzaría.
    .refine((value) => !SEQ_PATTERN.test(value) || BigInt(value) <= MAX_SEQ, { error: "seq excede el máximo de un bigint (2^63 - 1)" })
    .describe(description);

/** Compara dos `seq` como enteros: negativo si `a < b`, 0 si son iguales, positivo si `a > b`. */
export function compareSeq(a: string, b: string): number {
  const left = BigInt(a);
  const right = BigInt(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** `true` si `incoming` supera a `current`: la regla para aplicar un evento. Sin `current` (primer evento) siempre se aplica. */
export function isNewerSeq(incoming: string, current: string | undefined): boolean {
  return current === undefined || compareSeq(incoming, current) > 0;
}

/** `true` si `receivedAt` tiene más de `NO_SIGNAL_THRESHOLD_MS` de antigüedad contra `serverTime` (ambas ISO 8601). */
export function hasNoSignal(receivedAt: string, serverTime: string): boolean {
  return Date.parse(serverTime) - Date.parse(receivedAt) > NO_SIGNAL_THRESHOLD_MS;
}

/**
 * Namespace del uuid v5 de `alertId`. Constante del contrato: processor (que genera el id) y cualquier backfill o prueba deben
 * usar el mismo, o el mismo hecho produciría ids distintos.
 */
export const ALERT_ID_NAMESPACE = "6f1d3c2e-9b47-4a8e-8f55-2d0c7e4b1a93";

/**
 * Nombre del uuid v5 de una alerta: `alertId = uuidv5(alertIdName(...), ALERT_ID_NAMESPACE)`. Determinista, para que reprocesar el
 * mismo mensaje (reentrega de Kafka) produzca la MISMA alerta y el `INSERT ... ON CONFLICT DO NOTHING` sea idempotente.
 * `startedAt` se normaliza a ISO 8601 en UTC con milisegundos, así que el mismo instante con otro offset da el mismo nombre.
 */
export function alertIdName(vehicleId: string, type: string, startedAt: string): string {
  return `${vehicleId.toLowerCase()}|${type}|${new Date(startedAt).toISOString()}`;
}

const lon = z
  .number()
  .finite()
  .min(-180)
  .max(180)
  .describe("DATO PERSONAL (Ley 1581). Longitud en grados WGS84 (SRID 4326), de -180 a 180. Desde v1.");
const lat = z
  .number()
  .finite()
  .min(-90)
  .max(90)
  .describe("DATO PERSONAL (Ley 1581). Latitud en grados WGS84 (SRID 4326), de -90 a 90. Desde v1.");

const strictEnums = {
  movement: z.enum(MOVEMENTS),
  alertType: z.enum(ALERT_TYPES),
  zoneKind: z.enum(ZONE_KINDS),
  version: z.literal(1),
};
const tolerantEnums = {
  movement: z.enum([...MOVEMENTS, UNKNOWN_VALUE]).catch(UNKNOWN_VALUE),
  alertType: z.enum([...ALERT_TYPES, UNKNOWN_VALUE]).catch(UNKNOWN_VALUE),
  zoneKind: z.enum([...ZONE_KINDS, UNKNOWN_VALUE]).catch(UNKNOWN_VALUE),
  version: z.number().int().min(1),
};

/** Construye los esquemas que dependen de un enum con la variante estricta o la tolerante. */
function fleetModel<M extends z.ZodType, A extends z.ZodType, K extends z.ZodType, V extends z.ZodType>(enums: {
  movement: M;
  alertType: A;
  zoneKind: K;
  version: V;
}) {
  const vehicleState = z.object({
    vehicleId: z.uuid().describe("Vehículo. Key del mensaje en `vehicle.state`. Desde v1."),
    plate: z.string().min(1).max(32).describe("DATO PERSONAL (Ley 1581). Placa del vehículo. Desde v1."),
    lon,
    lat,
    recordedAt: datetime("Hora del fix GPS del dispositivo (ISO 8601 con offset). Con esta hora se calcula la detención. Desde v1."),
    receivedAt: datetime("Hora del servidor (gateway) al recibir el último punto. Base de `no_signal`. Desde v1."),
    speedMps: z.number().finite().min(0).max(150).nullable().describe("Velocidad en m/s, o null si el GPS no la entrega. Desde v1."),
    headingDeg: z.number().finite().min(0).lt(360).nullable().describe("Rumbo en grados desde el norte, o null. Desde v1."),
    movement: enums.movement.describe(
      "`moving` o `stopped`, calculado por el processor. Nunca `no_signal`: lo deriva fleet-api al leer (ver NO_SIGNAL_THRESHOLD_MS). Desde v1.",
    ),
    stoppedSince: datetime(
      "Desde cuándo está detenido, calculado con la hora del fix GPS (`recordedAt`), no la del servidor. Es null si y solo si `movement` es `moving`. Desde v1.",
    ).nullable(),
    zoneIds: z.array(z.uuid()).describe("Zonas que contienen la última posición (puede ser ninguna). Desde v1."),
    mocked: z.boolean().describe("El último punto venía de un proveedor de ubicación simulado. Desde v1."),
    lowAccuracy: z.boolean().describe("El último punto tenía baja precisión según el dispositivo. Desde v1."),
    seq: seq("Secuencia global (`fleet_event_seq`) de esta actualización, bigint como string. Ver la regla de orden del encabezado. Desde v1."),
  });

  const alert = z.object({
    alertId: z
      .uuid()
      .describe(
        "uuid v5 determinista: `uuidv5(alertIdName(vehicleId, type, startedAt), ALERT_ID_NAMESPACE)`. La misma alerta tiene siempre el mismo id: " +
          "la persistencia es idempotente y una resolución actualiza la misma fila. Desde v1.",
      ),
    vehicleId: z.uuid().describe("Vehículo de la alerta. Desde v1."),
    plate: z.string().min(1).max(32).describe("DATO PERSONAL (Ley 1581). Placa del vehículo. Desde v1."),
    type: enums.alertType.describe("`critical_zone_stop` (detenido en una zona crítica) o `mocked_location`. Desde v1."),
    zoneId: z.uuid().nullable().describe("Zona de la alerta, o null (`mocked_location`). Desde v1."),
    zoneName: z.string().min(1).nullable().describe("Nombre de la zona, o null. Desde v1."),
    startedAt: datetime("Cuándo empezó la condición, con la hora del fix GPS. Parte del `alertId`. Desde v1."),
    raisedAt: datetime("Cuándo la levantó el processor (hora del servidor). Desde v1."),
    resolvedAt: datetime("Cuándo se resolvió la condición, o null si sigue activa. Desde v1.").nullable(),
    seq: seq(
      "Secuencia global de esta versión de la alerta: el alta y la resolución toman cada una un `seq` nuevo, y el cliente conserva el mayor por `alertId`. Desde v1.",
    ),
  });

  const zoneProperties = z.object({
    zoneId: z.uuid().describe("Identificador de la zona. Desde v1."),
    name: z.string().min(1).describe("Nombre de la zona. Desde v1."),
    kind: enums.zoneKind.describe("`critical`, `depot` o `customer`. Desde v1."),
  });

  /** Posición GeoJSON `[lng, lat]` (regla 13: longitud primero). GeoJSON admite un tercer valor (altitud): se tolera. */
  const position = z.tuple([lon, lat], z.number().finite());
  const zoneFeatureCollection = z.object({
    type: z.literal("FeatureCollection"),
    features: z.array(
      z.object({
        type: z.literal("Feature"),
        geometry: z.object({
          type: z.literal("Polygon"),
          coordinates: z
            .array(z.array(position).min(4))
            .min(1)
            .describe("Anillos del polígono: el primero es el exterior. Cada anillo es una lista cerrada de `[lng, lat]` (mínimo 4). Desde v1."),
        }),
        properties: zoneProperties,
      }),
    ),
  });

  const stoppedVehiclesResponse = z.object({
    serverTime: datetime("Hora del servidor con la que se calculó `stoppedMinutes`. Desde v1."),
    items: z.array(
      z.object({
        vehicleId: z.uuid(),
        plate: z.string().min(1).max(32).describe("DATO PERSONAL (Ley 1581). Desde v1."),
        stoppedSince: datetime("Desde cuándo está detenido (hora del fix GPS). Desde v1."),
        stoppedMinutes: z.number().int().min(0).describe("Minutos enteros detenido: `floor((serverTime - stoppedSince) / 60 s)`. Desde v1."),
        lon,
        lat,
        zone: zoneProperties
          .nullable()
          .describe("Zona en la que está detenido, o null si no está en ninguna. Si está en varias, la elige fleet-api. Desde v1."),
      }),
    ),
  });

  const alertsResponse = z.object({
    items: z.array(alert).describe("Alertas del tenant, de la más reciente a la más antigua. Desde v1."),
    nextCursor: z
      .string()
      .min(1)
      .max(256)
      .nullable()
      .describe("Cursor OPACO de keyset para la página siguiente (se devuelve tal cual en `cursor`), o null si no hay más. Desde v1."),
  });

  const sseSnapshot = z.object({
    serverTime: datetime("Hora del servidor al armar el snapshot; base para derivar `no_signal` en el cliente. Desde v1."),
    cursor: seq(
      "Máximo `seq` incluido en el snapshot (\"0\" si no hay nada): referencia ordenable contra los eventos siguientes. También es el `id:` del evento. Desde v1.",
    ),
    vehicles: z.array(vehicleState).describe("Último estado de cada vehículo del tenant. Desde v1."),
    alerts: z.array(alert).describe("Alertas ACTIVAS (sin `resolvedAt`) del tenant. Desde v1."),
  });
  const sseVehicleState = z.object({ state: vehicleState });
  const sseAlert = z.object({ alert });

  const vehicleStateEvent = z.object({
    schemaVersion: enums.version.describe("Versión del evento. Desde v1."),
    tenantId: z.uuid().describe("Tenant dueño del vehículo. Desde v1."),
    state: vehicleState,
  });
  const alertEvent = z.object({
    schemaVersion: enums.version.describe("Versión del evento. Desde v1."),
    tenantId: z.uuid().describe("Tenant dueño de la alerta. Desde v1."),
    alert,
  });

  return {
    vehicleState,
    alert,
    zoneFeatureCollection,
    stoppedVehiclesResponse,
    alertsResponse,
    sseSnapshot,
    sseVehicleState,
    sseAlert,
    vehicleStateEvent,
    alertEvent,
  };
}

const strict = fleetModel(strictEnums);
const tolerant = fleetModel(tolerantEnums);

/** Último estado de un vehículo. Variante ESTRICTA (productores). Desde v1. */
export const vehicleStateSchema = strict.vehicleState;
export type VehicleState = z.infer<typeof vehicleStateSchema>;
/** Igual, TOLERANTE (web y móvil): un `movement` desconocido se lee como `"unknown"`. Desde v1. */
export const vehicleStateTolerantSchema = tolerant.vehicleState;
export type VehicleStateTolerant = z.infer<typeof vehicleStateTolerantSchema>;

/** Alerta de la flota. Variante ESTRICTA. Desde v1. */
export const alertSchema = strict.alert;
export type Alert = z.infer<typeof alertSchema>;
/** Igual, TOLERANTE: un `type` desconocido se lee como `"unknown"`. Desde v1. */
export const alertTolerantSchema = tolerant.alert;
export type AlertTolerant = z.infer<typeof alertTolerantSchema>;

/**
 * Zonas del tenant como GeoJSON `FeatureCollection` de `Polygon`, coordenadas `[lng, lat]` (regla 13). Respuesta de
 * `GET /v1/zones/geojson`. Variante ESTRICTA. Desde v1.
 */
export const zoneFeatureCollectionSchema = strict.zoneFeatureCollection;
export type ZoneFeatureCollection = z.infer<typeof zoneFeatureCollectionSchema>;
/** Igual, TOLERANTE: un `kind` desconocido se lee como `"unknown"`. Desde v1. */
export const zoneFeatureCollectionTolerantSchema = tolerant.zoneFeatureCollection;
export type ZoneFeatureCollectionTolerant = z.infer<typeof zoneFeatureCollectionTolerantSchema>;

/**
 * Resumen de la flota (`GET /v1/summary`). Desde v1.
 *
 * Los conteos de `vehicles` PARTICIONAN la flota: `total = moving + stopped + noSignal`. Un vehículo sin señal (derivado al leer,
 * ver `NO_SIGNAL_THRESHOLD_MS`) cuenta solo en `noSignal`, no en `moving` ni `stopped`.
 */
export const fleetSummarySchema = z.object({
  serverTime: datetime("Hora del servidor con la que se derivó `noSignal`. Desde v1."),
  vehicles: z.object({
    total: z.number().int().min(0).describe("Vehículos del tenant. Desde v1."),
    moving: z.number().int().min(0).describe("En movimiento y con señal. Desde v1."),
    stopped: z.number().int().min(0).describe("Detenidos y con señal. Desde v1."),
    noSignal: z.number().int().min(0).describe("Sin señal: `receivedAt` más viejo que NO_SIGNAL_THRESHOLD_MS. Desde v1."),
  }),
  activeAlerts: z.number().int().min(0).describe("Alertas activas (sin `resolvedAt`) del tenant. Desde v1."),
});
export type FleetSummary = z.infer<typeof fleetSummarySchema>;

/**
 * Querystring de `GET /v1/vehicles/stopped` (la pregunta "¿qué vehículos llevan más de X minutos detenidos?"). Llega como texto:
 * los números se convierten. Entrada del servidor, solo ESTRICTA. Desde v1.
 */
export const stoppedVehiclesQuerySchema = z.object({
  minMinutes: z.coerce.number().int().min(1).max(1440).default(20).describe("Mínimo de minutos detenido (1 a 1440). Por defecto 20. Desde v1."),
  zoneKind: z.enum(ZONE_KINDS).optional().describe("Solo los detenidos en una zona de este tipo. Sin él, todos. Desde v1."),
  limit: z.coerce.number().int().min(1).max(200).default(50).describe("Máximo de vehículos devueltos (1 a 200). Por defecto 50. Desde v1."),
});
export type StoppedVehiclesQuery = z.infer<typeof stoppedVehiclesQuerySchema>;

/** Respuesta de `GET /v1/vehicles/stopped`. Variante ESTRICTA. Desde v1. */
export const stoppedVehiclesResponseSchema = strict.stoppedVehiclesResponse;
export type StoppedVehiclesResponse = z.infer<typeof stoppedVehiclesResponseSchema>;
/** Igual, TOLERANTE: un `zone.kind` desconocido se lee como `"unknown"`. Desde v1. */
export const stoppedVehiclesResponseTolerantSchema = tolerant.stoppedVehiclesResponse;
export type StoppedVehiclesResponseTolerant = z.infer<typeof stoppedVehiclesResponseTolerantSchema>;

/** Querystring de `GET /v1/alerts`, paginado por keyset. Entrada del servidor, solo ESTRICTA. Desde v1. */
export const alertsQuerySchema = z.object({
  status: z.enum(["active", "all"]).default("active").describe("`active` (sin resolver) o `all`. Por defecto `active`. Desde v1."),
  limit: z.coerce.number().int().min(1).max(200).default(50).describe("Tamaño de página (1 a 200). Por defecto 50. Desde v1."),
  cursor: z.string().min(1).max(256).optional().describe("`nextCursor` de la página anterior; sin él, la primera página. Desde v1."),
});
export type AlertsQuery = z.infer<typeof alertsQuerySchema>;

/** Respuesta de `GET /v1/alerts`. Variante ESTRICTA. Desde v1. */
export const alertsResponseSchema = strict.alertsResponse;
export type AlertsResponse = z.infer<typeof alertsResponseSchema>;
/** Igual, TOLERANTE: un `type` desconocido se lee como `"unknown"`. Desde v1. */
export const alertsResponseTolerantSchema = tolerant.alertsResponse;
export type AlertsResponseTolerant = z.infer<typeof alertsResponseTolerantSchema>;

/**
 * Evento SSE `snapshot` (`GET /v1/stream`). SIEMPRE es el primer evento de la conexión, y su `id:` es `cursor`. Desde v1.
 * El cliente reemplaza su estado por el snapshot y aplica después solo los eventos cuyo `seq` supere al de cada vehículo.
 * Variante ESTRICTA.
 */
export const sseSnapshotSchema = strict.sseSnapshot;
export type SseSnapshot = z.infer<typeof sseSnapshotSchema>;
/** Igual, TOLERANTE. Desde v1. */
export const sseSnapshotTolerantSchema = tolerant.sseSnapshot;
export type SseSnapshotTolerant = z.infer<typeof sseSnapshotTolerantSchema>;

/** Datos del evento SSE `vehicle.state`; su `id:` es `state.seq`. Variante ESTRICTA. Desde v1. */
export const sseVehicleStateSchema = strict.sseVehicleState;
export type SseVehicleState = z.infer<typeof sseVehicleStateSchema>;
/** Igual, TOLERANTE. Desde v1. */
export const sseVehicleStateTolerantSchema = tolerant.sseVehicleState;
export type SseVehicleStateTolerant = z.infer<typeof sseVehicleStateTolerantSchema>;

/** Datos del evento SSE `alert`; su `id:` es `alert.seq`. Variante ESTRICTA. Desde v1. */
export const sseAlertSchema = strict.sseAlert;
export type SseAlert = z.infer<typeof sseAlertSchema>;
/** Igual, TOLERANTE. Desde v1. */
export const sseAlertTolerantSchema = tolerant.sseAlert;
export type SseAlertTolerant = z.infer<typeof sseAlertTolerantSchema>;

/**
 * Valor del mensaje en `vehicle.state`. Productor: `processor`; consumidor: `fleet-api`. La key es `vehicleId` y el
 * `correlationId` viaja en los headers. Variante ESTRICTA (`schemaVersion: 1`). Desde v1.
 */
export const vehicleStateEventSchema = strict.vehicleStateEvent;
export type VehicleStateEvent = z.infer<typeof vehicleStateEventSchema>;
/** Igual, TOLERANTE: cualquier `schemaVersion` entera >= 1 y un `movement` desconocido como `"unknown"`. Desde v1. */
export const vehicleStateEventTolerantSchema = tolerant.vehicleStateEvent;
export type VehicleStateEventTolerant = z.infer<typeof vehicleStateEventTolerantSchema>;

/**
 * Valor del mensaje en `fleet.alerts`: el alta de una alerta y su resolución (misma `alertId`, `seq` mayor). Key = `vehicleId`,
 * `correlationId` en los headers. Variante ESTRICTA. Desde v1.
 */
export const alertEventSchema = strict.alertEvent;
export type AlertEvent = z.infer<typeof alertEventSchema>;
/** Igual, TOLERANTE. Desde v1. */
export const alertEventTolerantSchema = tolerant.alertEvent;
export type AlertEventTolerant = z.infer<typeof alertEventTolerantSchema>;

/**
 * Cuerpo de `POST /v1/session` (login). Desde v1. La contraseña nunca se registra en logs. Se valida solo que exista: la
 * política de contraseñas es del servidor, no un límite que un cliente viejo deba conocer.
 */
export const loginRequestSchema = z.object({
  email: z.email().max(254).describe("Correo del usuario. Se compara sin distinguir mayúsculas. Desde v1."),
  password: z.string().min(1).max(256).describe("Contraseña en claro, solo por TLS. Desde v1."),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/**
 * Sesión autenticada (respuesta del login y de `GET /v1/session`). Desde v1. La cookie de sesión NO es parte del contrato: es
 * `HttpOnly` y el cliente nunca la lee. El `tenantId` de todas las consultas sale de esta identidad, nunca del cliente.
 */
export const sessionSchema = z.object({
  user: z.object({
    userId: z.uuid().describe("Identificador del usuario. Desde v1."),
    email: z.email().describe("DATO PERSONAL (Ley 1581). Desde v1."),
    name: z.string().min(1).describe("DATO PERSONAL (Ley 1581). Nombre para mostrar. Desde v1."),
  }),
  tenant: z.object({
    tenantId: z.uuid().describe("Tenant del usuario. Desde v1."),
    name: z.string().min(1).describe("Nombre del tenant. Desde v1."),
  }),
});
export type Session = z.infer<typeof sessionSchema>;

const pairingCode = new RegExp(`^[${PAIRING_CODE_ALPHABET}]{${PAIRING_CODE_LENGTH}}$`);

/** Cuerpo de `POST /v1/pairing-codes` (un operador pide un código para un vehículo de su tenant). Desde v1. */
export const pairingCodeCreateRequestSchema = z.object({
  vehicleId: z.uuid().describe("Vehículo a vincular. Debe ser del tenant de la sesión. Desde v1."),
});
export type PairingCodeCreateRequest = z.infer<typeof pairingCodeCreateRequestSchema>;

/** Código de vinculación de un solo uso y corta vida. Respuesta de `POST /v1/pairing-codes`. Desde v1. */
export const pairingCodeSchema = z.object({
  code: z
    .string()
    .regex(pairingCode, { error: `el código son ${PAIRING_CODE_LENGTH} caracteres de PAIRING_CODE_ALPHABET` })
    .describe(`${PAIRING_CODE_LENGTH} caracteres de PAIRING_CODE_ALPHABET (sin ambiguos), en mayúsculas. Solo se guarda su hash. Desde v1.`),
  vehicleId: z.uuid().describe("Vehículo al que vincula. Desde v1."),
  expiresAt: datetime("Cuándo vence el código. Desde v1."),
});
export type PairingCode = z.infer<typeof pairingCodeSchema>;

/** Cuerpo de `POST /v1/devices/pair` (el móvil canjea el código). Sin sesión: la autenticación es el propio código. Desde v1. */
export const devicePairRequestSchema = z.object({
  code: z
    .string()
    .regex(pairingCode, { error: `el código son ${PAIRING_CODE_LENGTH} caracteres de PAIRING_CODE_ALPHABET` })
    .describe("Código de vinculación, en mayúsculas (el móvil normaliza lo que teclea el usuario). Desde v1."),
});
export type DevicePairRequest = z.infer<typeof devicePairRequestSchema>;

function devicePairResponseOf<T extends z.ZodType>(deviceToken: T) {
  return z.object({
    deviceToken: deviceToken.describe("Token del dispositivo, devuelto UNA sola vez; el servidor solo guarda su hash. Nunca se registra en logs. Desde v1."),
    vehicleId: z.uuid().describe("Vehículo vinculado. Desde v1."),
    plate: z.string().min(1).max(32).describe("DATO PERSONAL (Ley 1581). Placa para mostrar en el móvil. Desde v1."),
    pairedAt: datetime("Hora del servidor en que se vinculó. Desde v1."),
  });
}

/**
 * Respuesta de `POST /v1/devices/pair`. Variante ESTRICTA, para el productor (fleet-api): el token tiene el formato exacto de
 * `deviceTokenSchema` (`fdt_` + 43 caracteres). Desde v1.
 */
export const devicePairResponseSchema = devicePairResponseOf(deviceTokenSchema);
export type DevicePairResponse = z.infer<typeof devicePairResponseSchema>;
/**
 * Igual, TOLERANTE, para el móvil: acepta cualquier token que empiece por `fdt_` y no esté vacío después, así que un cambio futuro
 * del largo del token no impide que un móvil ya instalado guarde el suyo (lo trata como opaco). Desde v1.
 */
export const devicePairResponseTolerantSchema = devicePairResponseOf(
  z.string().startsWith(DEVICE_TOKEN_PREFIX).min(DEVICE_TOKEN_PREFIX.length + 1),
);
export type DevicePairResponseTolerant = z.infer<typeof devicePairResponseTolerantSchema>;
