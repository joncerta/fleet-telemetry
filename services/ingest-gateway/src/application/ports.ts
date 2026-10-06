import type { TelemetryDlqMessage, TelemetryRawEvent } from "@fleet/contracts";
import type { DeviceContext } from "../domain/device.js";

/** Puertos del ingest-gateway: lo que sus casos de uso necesitan del mundo exterior. */

/** Reloj del servidor. Un puerto, para que los casos de uso no dependan de la hora real en los tests. */
export interface Clock {
  now(): Date;
}

/** Dispositivos registrados. Solo lectura: la emisión y rotación de tokens es de `pnpm device:token`. */
export interface DeviceRepository {
  /**
   * El dispositivo NO revocado cuyo token tiene ese hash (`sha256Hex` del token completo, hexadecimal minúscula), o
   * `null` si no existe o está revocado. Un fallo de la base se propaga (no se confunde con "no existe").
   */
  findActiveByTokenHash(tokenHash: string): Promise<DeviceContext | null>;
}

/** Datos comunes de una publicación. */
export interface PublishContext {
  /**
   * Vehículo del token (no el que diga el punto). Es la key de Kafka de todos los mensajes: así mantienen el orden por
   * vehículo aunque el uuid del punto venga con otras mayúsculas.
   */
  readonly vehicleId: string;
  readonly correlationId: string;
}

/**
 * Publica en Kafka los resultados de un lote. Cada método resuelve solo cuando TODOS sus mensajes quedaron confirmados
 * por el broker (`acks=-1`) y rechaza si no lo lograron (error, o tiempo agotado): nunca resuelve a medias.
 */
export interface TelemetryPublisher {
  /** Puntos válidos, a `telemetry.raw`. */
  publishAccepted(context: PublishContext, events: readonly TelemetryRawEvent[]): Promise<void>;
  /** Puntos rechazados, a `telemetry.dlq`. */
  publishRejected(context: PublishContext, messages: readonly TelemetryDlqMessage[]): Promise<void>;
}

/** Una dependencia cuyo estado informa `GET /health`. La implementación decide qué significa "responde". */
export interface ReadinessCheck {
  /** Clave en `checks` de la respuesta (`database`, `kafka`...). */
  readonly name: string;
  /**
   * `true` si la dependencia responde. No lanza: un fallo (o un tiempo agotado) es `false`, y el detalle va al log
   * del adaptador, nunca a la respuesta.
   */
  check(): Promise<boolean>;
}
