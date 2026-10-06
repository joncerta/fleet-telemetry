export interface Startable {
  start(): void;
  stop(): void;
}

export interface SharedResource {
  /** Pide el recurso; lo arranca si nadie lo tenía. Devuelve la función que lo suelta (idempotente). */
  acquire(): () => void;
  /** Detiene el recurso ya, aunque alguien lo tenga (cierre de sesión). */
  dispose(): void;
}

/**
 * UNA instancia compartida (la conexión SSE) con conteo de referencias. Se crea con el primer `acquire` y se detiene cuando el último la
 * suelta, tras `releaseDelayMs`: en desarrollo, StrictMode monta, desmonta y vuelve a montar cada efecto, y sin ese margen se cerraría y
 * abriría otra conexión. Si alguien la vuelve a pedir dentro del margen, se reutiliza la misma.
 */
export function createSharedResource(factory: () => Startable, releaseDelayMs = 0): SharedResource {
  let instance: Startable | null = null;
  // Un símbolo por `acquire`: un `release` tardío (de antes de `dispose`) no descuenta a los titulares nuevos.
  const holders = new Set<symbol>();
  let pendingStop: ReturnType<typeof setTimeout> | undefined;

  const stopNow = () => {
    clearTimeout(pendingStop);
    pendingStop = undefined;
    instance?.stop();
    instance = null;
  };

  return {
    acquire() {
      const holder = Symbol("holder");
      holders.add(holder);
      clearTimeout(pendingStop);
      pendingStop = undefined;
      if (instance === null) {
        instance = factory();
        instance.start();
      }
      return () => {
        if (!holders.delete(holder)) return;
        if (holders.size === 0) pendingStop = setTimeout(stopNow, releaseDelayMs);
      };
    },
    dispose() {
      holders.clear();
      stopNow();
    },
  };
}
