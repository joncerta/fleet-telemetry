/**
 * La base de datos no atendió la persistencia tras agotar los reintentos de un fallo TRANSITORIO. Es una caída de
 * infraestructura, no un mensaje malo: no va a la DLQ. El error sube hasta kafkajs, que no confirma el offset y reentrega
 * el lote (at-least-once; el sumidero es idempotente). `cause` conserva el error original para el log.
 */
export class PersistenceUnavailableError extends Error {
  readonly attempts: number;

  constructor(attempts: number, cause: unknown) {
    super(`La base no atendió la persistencia tras ${attempts} intentos.`, { cause });
    this.name = "PersistenceUnavailableError";
    this.attempts = attempts;
  }
}

/**
 * Un mensaje de `telemetry.raw` declara una `schemaVersion` mayor que la que este consumer conoce: un productor se desplegó
 * antes que su consumer. No es un error del contenido, así que NO va a la DLQ (regla 7): el error sube hasta kafkajs, que no
 * confirma el offset y reentrega, y la partición queda detenida hasta desplegar la versión nueva del processor. La regla de
 * despliegue (consumers antes que productores, ADR-005.14) evita llegar aquí.
 */
export class UnsupportedSchemaVersionError extends Error {
  readonly version: number;
  readonly offset: string;

  constructor(version: number, offset: string) {
    super(`El mensaje del offset ${offset} declara la schemaVersion ${version}, que este processor no conoce.`);
    this.name = "UnsupportedSchemaVersionError";
    this.version = version;
    this.offset = offset;
  }
}

/**
 * No se pudo publicar en `telemetry.dlq` (error del broker o tiempo agotado). Sin DLQ confirmada no se resuelve ningún
 * offset del tramo: el lote se reentrega y la persistencia, idempotente, no duplica nada.
 */
export class DeadLetterPublicationError extends Error {
  readonly messages: number;

  constructor(messages: number, cause: unknown) {
    super(`No se pudieron publicar ${messages} mensajes en la DLQ.`, { cause });
    this.name = "DeadLetterPublicationError";
    this.messages = messages;
  }
}

/**
 * No se pudo publicar en `vehicle.state` o `fleet.alerts` (error del broker o tiempo agotado). El estado ya está en la base, pero sin
 * la publicación confirmada no se resuelve ningún offset del tramo: el lote se reentrega, el estado no cambia (los puntos ya
 * persistidos son tardíos para él) y se vuelve a publicar el estado vigente, así que ningún evento se pierde.
 */
export class FleetEventPublicationError extends Error {
  readonly events: number;

  constructor(events: number, cause: unknown) {
    super(`No se pudieron publicar ${events} eventos de la flota.`, { cause });
    this.name = "FleetEventPublicationError";
    this.events = events;
  }
}
