import type { DeviceRepository } from "../application/ports.js";

export interface LimitedDeviceRepositoryOptions {
  /** Consultas simultáneas al repositorio interno. Por encima, se rechaza sin llamarlo. */
  maxInFlight: number;
}

/**
 * Se alcanzó el tope de consultas de autenticación en vuelo. No es un "no existe": el token puede ser válido. El caso de uso
 * lo traduce, como cualquier fallo del directorio, a `DeviceDirectoryUnavailableError` (503 con `Retry-After`, sin contar
 * como 401).
 */
export class DeviceLookupSaturatedError extends Error {
  constructor(maxInFlight: number) {
    super(`Hay ${maxInFlight} consultas de autenticación en vuelo.`);
    this.name = "DeviceLookupSaturatedError";
  }
}

/**
 * Decorador que acota las consultas simultáneas de un `DeviceRepository`. Va DEBAJO de la caché de tokens: un acierto de caché
 * no llega aquí y no cuenta. Cada token inventado es un fallo de caché (la caché negativa solo evita repetir la MISMA
 * consulta durante unos segundos, no protege de tokens distintos), así que sin este tope un flood de tokens al azar saturaría
 * el pool y dejaría sin autenticar también a los dispositivos legítimos cuyo token no esté en caché.
 *
 * Al saturarse falla de inmediato, sin cola y sin tocar el repositorio interno (ni el pool). El cupo se libera siempre,
 * con éxito o con error. El tope debería ser igual al tamaño del pool que usa el repositorio interno.
 */
export function createLimitedDeviceRepository(inner: DeviceRepository, options: LimitedDeviceRepositoryOptions): DeviceRepository {
  const { maxInFlight } = options;
  if (!Number.isInteger(maxInFlight) || maxInFlight < 1) throw new RangeError("maxInFlight debe ser un entero positivo.");
  let inFlight = 0;

  return {
    async findActiveByTokenHash(tokenHash) {
      if (inFlight >= maxInFlight) throw new DeviceLookupSaturatedError(maxInFlight);
      inFlight += 1;
      try {
        return await inner.findActiveByTokenHash(tokenHash);
      } finally {
        inFlight -= 1;
      }
    },
  };
}
