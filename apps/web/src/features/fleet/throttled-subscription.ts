interface ReadableStore<S> {
  getState(): S;
  subscribe(listener: (state: S) => void): () => void;
}

export interface ThrottleClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

const realClock: ThrottleClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

/**
 * Lee `selector` del store, pero avisa a lo sumo cada `intervalMs`: el primer cambio sale al momento y los que llegan dentro del intervalo
 * se juntan en UNA lectura final (la más reciente). Las listas del panel no se recalculan con cada lote de eventos (cada 200 ms), sino a
 * la cadencia del mapa. Después de la lectura inicial, solo avisa si el valor cambió según `equals`. Devuelve la función que cancela.
 */
export function subscribeThrottled<S, T>(
  store: ReadableStore<S>,
  selector: (state: S) => T,
  intervalMs: number,
  onChange: (value: T) => void,
  equals: (a: T, b: T) => boolean = Object.is,
  clock: ThrottleClock = realClock,
): () => void {
  let last: { value: T } | null = null;
  let lastEmitAt = Number.NEGATIVE_INFINITY;
  let timer: unknown;
  let pending = false;

  const emit = () => {
    pending = false;
    lastEmitAt = clock.now();
    const value = selector(store.getState());
    if (last !== null && equals(value, last.value)) return;
    last = { value };
    onChange(value);
  };

  // Lectura inicial: el valor pudo cambiar entre el render y la suscripción, así que siempre se entrega.
  emit();
  const unsubscribe = store.subscribe(() => {
    if (pending) return;
    pending = true;
    const wait = Math.max(0, lastEmitAt + intervalMs - clock.now());
    if (wait === 0) {
      emit();
      return;
    }
    timer = clock.setTimeout(emit, wait);
  });

  return () => {
    unsubscribe();
    if (pending) clock.clearTimeout(timer);
    pending = false;
  };
}
