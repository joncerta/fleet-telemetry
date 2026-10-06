import type { Alert, AlertEvent, TelemetryDlqMessage, TelemetryRawEvent, VehicleState, VehicleStateEvent } from "@fleet/contracts";
import type { OpenAlert, VehicleSnapshot, ZoneRef } from "../domain/vehicle-state.js";

/** Puertos del processor: lo que sus casos de uso necesitan del mundo exterior. */

/** Reloj del servidor. Un puerto, para que los casos de uso no dependan de la hora real en los tests. */
export interface Clock {
  now(): Date;
}

/** Espera entre reintentos. Un puerto, para probar el backoff sin esperar de verdad. */
export interface Sleeper {
  sleep(ms: number): Promise<void>;
}

/** Aleatoriedad para el jitter del backoff. */
export interface Randomness {
  /** Un número en `[0, 1)`. */
  next(): number;
}

export interface InsertOutcome {
  /** Filas realmente insertadas. Las que ya existían (mismo `eventId` y `recordedAt`) no cuentan. */
  readonly inserted: number;
}

/** Almacén de la telemetría. */
export interface TelemetryRepository {
  /**
   * Inserta los eventos en UNA sola operación atómica e idempotente: lo que ya existe (mismo `eventId` y `recordedAt`) se
   * ignora, también si se repite dentro de `events`. Si la operación falla, no queda nada insertado. El error de la base
   * se propaga tal cual (el caso de uso lo clasifica).
   */
  insertBatch(events: readonly TelemetryRawEvent[]): Promise<InsertOutcome>;
}

export interface DeadLetterEntry {
  /** Key del mensaje de Kafka: el `vehicleId` si se conoce. */
  readonly key: string;
  readonly correlationId: string;
  readonly message: TelemetryDlqMessage;
}

/** Publica en `telemetry.dlq`. */
export interface DeadLetterPublisher {
  /**
   * Resuelve solo cuando TODOS los mensajes quedaron confirmados por el broker (`acks=-1`) y rechaza si no lo lograron:
   * nunca resuelve a medias.
   */
  publish(entries: readonly DeadLetterEntry[]): Promise<void>;
}

/**
 * El avance dentro de un lote de Kafka de una partición. Es lo único que el caso de uso sabe de los offsets: la entrada
 * lo implementa con las funciones del consumer. Nada se confirma hasta que `resolve` marca el offset, y el caso de uso
 * solo lo llama DESPUÉS de persistir y de que la DLQ de ese tramo esté confirmada (regla 6 de CLAUDE.md).
 */
export interface BatchCheckpoint {
  /** Marca como procesados todos los mensajes de la partición hasta `offset` inclusive. */
  resolve(offset: string): void;
  /** Avisa al broker de que el consumer sigue vivo. Puede rechazar si hay un rebalanceo: el error se propaga. */
  heartbeat(): Promise<void>;
  /**
   * Confirma en el broker, YA (sin esperar umbrales), todo lo procesado de la partición hasta `offset` inclusive. La entrada
   * calcula el siguiente offset a leer y lo pasa explícito: `commitOffsetsIfNecessary()` sin argumentos de kafkajs no confirma
   * nada mientras no se cumpla un umbral, y no hay ninguno configurado.
   */
  commit(offset: string): Promise<void>;
  /** `false` si el consumer se está deteniendo o la partición se reasignó: hay que dejar de procesar, sin error. */
  shouldContinue(): boolean;
}

/** Lo que el caso de uso necesita de un logger estructurado. Nunca recibe coordenadas ni el contenido de un mensaje. */
export interface ProcessorLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

/** Estado de un vehículo para escribir: el `seq` lo asigna la base (`nextval('fleet_event_seq')`), no el llamador. */
export interface VehicleStateWrite {
  readonly vehicleId: string;
  readonly snapshot: VehicleSnapshot;
}

export interface AlertWrite {
  /** uuid v5 determinista: el mismo hecho produce siempre el mismo id, y reprocesar es un no-op. */
  readonly alertId: string;
  readonly vehicleId: string;
  readonly type: OpenAlert["type"];
  readonly zoneId: string | null;
  /** Hora del fix GPS en que empezó la condición. */
  readonly startedAt: string;
  /** Hora del servidor en que el processor la levantó. */
  readonly raisedAt: string;
  /** Solo si se levantó y se resolvió dentro del mismo tramo. */
  readonly resolvedAt: string | null;
}

export interface AlertResolutionWrite {
  readonly alertId: string;
  /** Hora del fix GPS del punto que la resolvió. */
  readonly resolvedAt: string;
}

/** Lo que se publica tras confirmar la transacción: el estado vigente de los vehículos tocados y sus alertas relevantes. */
export interface PublishableFleet {
  readonly states: readonly VehicleState[];
  readonly alerts: readonly Alert[];
}

/**
 * Operaciones de UNA transacción sobre el read model de la flota. TODA operación recibe el `tenantId` del evento y filtra por él
 * (regla 4): un vehículo, una zona o una alerta de otro tenant no existen para ella. Los errores de la base se propagan tal cual.
 */
export interface FleetStateTransaction {
  /** Estado previo de los vehículos, con la fila bloqueada (`FOR UPDATE`) hasta el fin de la transacción. Sin entrada: no hay estado. */
  lockVehicleStates(tenantId: string, vehicleIds: readonly string[]): Promise<ReadonlyMap<string, VehicleSnapshot>>;
  /** Alertas ACTIVAS (sin resolver) de esos vehículos, bloqueadas, por `vehicleId`. */
  lockOpenAlerts(tenantId: string, vehicleIds: readonly string[]): Promise<ReadonlyMap<string, readonly OpenAlert[]>>;
  /** Zonas del tenant que contienen cada posición, en el mismo orden que `positions` (una lista, posiblemente vacía, por posición). */
  zonesCovering(tenantId: string, positions: readonly { readonly lon: number; readonly lat: number }[]): Promise<readonly (readonly ZoneRef[])[]>;
  /** Inserta o actualiza el estado de cada vehículo (una fila por vehículo) con un `seq` nuevo. Nunca retrocede `recordedAt`. */
  upsertVehicleStates(tenantId: string, states: readonly VehicleStateWrite[]): Promise<void>;
  /** Inserta alertas nuevas; una que ya existe (mismo `alertId`) se ignora. Devuelve los `alertId` realmente insertados. */
  insertAlerts(tenantId: string, alerts: readonly AlertWrite[]): Promise<readonly string[]>;
  /** Marca resueltas las alertas activas indicadas, con un `seq` nuevo. Devuelve los `alertId` realmente resueltos. */
  resolveAlerts(tenantId: string, resolutions: readonly AlertResolutionWrite[]): Promise<readonly string[]>;
  /**
   * Lee, ya escrito, lo que hay que publicar: el estado vigente de los vehículos (con su placa) y sus alertas ACTIVAS o resueltas
   * a partir de `alertsSince` (con la placa y el nombre de la zona). Se lee SIEMPRE, haya cambiado el estado o no: es lo que
   * permite republicar tras una reentrega.
   */
  readPublishable(tenantId: string, query: { readonly vehicleIds: readonly string[]; readonly alertsSince: string }): Promise<PublishableFleet>;
}

/** Ejecuta trabajo en una sola transacción: confirma si `work` termina y revierte (sin dejar nada) si lanza. */
export interface FleetStateUnitOfWork {
  run<T>(work: (tx: FleetStateTransaction) => Promise<T>): Promise<T>;
}

/** Genera el `alertId` (uuid v5) de un nombre determinista (`alertIdName`). Detrás de un puerto porque el hash es de infraestructura. */
export interface AlertIdGenerator {
  generate(name: string): string;
}

/** Un evento de Kafka listo para publicar. */
export interface KeyedEvent<T> {
  /** Key del mensaje: el `vehicleId` (mantiene el orden por vehículo). */
  readonly key: string;
  /** `correlationId` del mensaje original, para el header. */
  readonly correlationId: string;
  readonly event: T;
}

export interface FleetEvents {
  readonly vehicleStates: readonly KeyedEvent<VehicleStateEvent>[];
  readonly alerts: readonly KeyedEvent<AlertEvent>[];
}

/** Publica en `vehicle.state` y `fleet.alerts`. */
export interface FleetEventPublisher {
  /**
   * Resuelve solo cuando TODOS los mensajes quedaron confirmados por el broker (`acks=-1`) y rechaza si no lo lograron: nunca
   * resuelve a medias. Cada mensaje se valida con el esquema estricto del contrato antes de enviarse.
   */
  publish(events: FleetEvents): Promise<void>;
}
