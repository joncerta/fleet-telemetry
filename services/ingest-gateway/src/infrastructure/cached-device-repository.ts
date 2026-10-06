import type { DeviceRepository } from "../application/ports.js";
import type { DeviceContext } from "../domain/device.js";
import { TtlCache } from "./ttl-cache.js";

export interface DeviceCacheOptions {
  /** Cuánto se recuerda un token válido. La revocación de un dispositivo tarda como máximo esto en aplicarse. */
  ttlMs: number;
  /** Cuánto se recuerda un token que no existe o está revocado. Más corto: un dispositivo recién creado debe poder entrar pronto. */
  negativeTtlMs: number;
  /** Tope de entradas de CADA caché (la de aciertos y la de fallos). */
  maxEntries: number;
  /** Reloj en ms; por defecto `Date.now`. */
  now?: () => number;
}

/**
 * Decorador con caché de un `DeviceRepository`, para no consultar la base en cada lote.
 *
 * - **Revocación:** un token revocado sigue funcionando hasta `ttlMs` (30 s por defecto) en cada réplica; cuando su
 *   entrada vence, la búsqueda vuelve a la base y ya no lo encuentra. Es el precio de no consultar la base por lote.
 * - **Dos cachés separadas.** Quien prueba tokens al azar (fuerza bruta) solo llena la de fallos, que está acotada y
 *   dura poco; no puede expulsar a los dispositivos legítimos de la de aciertos.
 * - **Una consulta a la vez por hash:** peticiones simultáneas con el mismo token comparten la misma consulta.
 * - Un error de la base NO se guarda: la siguiente petición lo vuelve a intentar.
 * - Las claves son el hash del token, no el token.
 */
export function createCachedDeviceRepository(inner: DeviceRepository, options: DeviceCacheOptions): DeviceRepository {
  const now = options.now;
  const hits = new TtlCache<DeviceContext>({ ttlMs: options.ttlMs, maxEntries: options.maxEntries, ...(now !== undefined && { now }) });
  const misses = new TtlCache<null>({ ttlMs: options.negativeTtlMs, maxEntries: options.maxEntries, ...(now !== undefined && { now }) });
  const inFlight = new Map<string, Promise<DeviceContext | null>>();

  async function load(tokenHash: string): Promise<DeviceContext | null> {
    const device = await inner.findActiveByTokenHash(tokenHash);
    if (device === null) misses.set(tokenHash, null);
    else hits.set(tokenHash, device);
    return device;
  }

  return {
    findActiveByTokenHash(tokenHash) {
      const hit = hits.get(tokenHash);
      if (hit !== undefined) return Promise.resolve(hit.value);
      if (misses.get(tokenHash) !== undefined) return Promise.resolve(null);

      const pending = inFlight.get(tokenHash);
      if (pending !== undefined) return pending;
      const started = load(tokenHash).finally(() => inFlight.delete(tokenHash));
      inFlight.set(tokenHash, started);
      return started;
    },
  };
}
