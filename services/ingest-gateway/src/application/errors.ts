/** Destino de una publicación que falló. */
export type PublicationTarget = "telemetry.raw" | "telemetry.dlq";

/**
 * El lote NO se pudo publicar completo en Kafka (error del broker o tiempo agotado) en al menos un tópico. Es el único
 * error de negocio del caso de uso: la entrada lo traduce a `503 service_unavailable`, sin ACK parcial. El móvil reintenta
 * el lote entero y es seguro, porque la persistencia es idempotente. `cause` conserva el error original para el log.
 */
export class PublicationFailedError extends Error {
  readonly targets: readonly PublicationTarget[];

  constructor(targets: readonly PublicationTarget[], cause: unknown) {
    super(`No se pudo publicar el lote en: ${targets.join(", ")}.`, { cause });
    this.name = "PublicationFailedError";
    this.targets = targets;
  }
}

/**
 * El directorio de dispositivos (la base) no respondió al autenticar. NO es un "no autenticado": el token puede ser válido.
 * La entrada lo traduce a `503 service_unavailable` con `Retry-After`, y el móvil conserva su cola y reintenta (un 500 o un
 * 401 podrían hacerle descartar o reautenticar). `cause` conserva el error original para el log; nunca llega al cliente.
 *
 * Opción por ahora descartada (ADR-004): servir una entrada de caché ya vencida mientras la base no responde
 * (stale-if-error). Mantendría ingiriendo durante una caída corta, a cambio de aceptar un token que pudo revocarse.
 */
export class DeviceDirectoryUnavailableError extends Error {
  constructor(cause: unknown) {
    super("El directorio de dispositivos no está disponible.", { cause });
    this.name = "DeviceDirectoryUnavailableError";
  }
}
