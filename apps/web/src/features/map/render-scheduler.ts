type TimerId = ReturnType<typeof setTimeout>;

export interface Timers {
  setTimeout(callback: () => void, ms: number): TimerId;
  clearTimeout(id: TimerId): void;
  setInterval(callback: () => void, ms: number): TimerId;
  clearInterval(id: TimerId): void;
}

const browserTimers: Timers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (id) => clearInterval(id),
};

export interface RenderSchedulerOptions {
  /** Separación mínima entre dos `render` (500 ms: el `setData` del mapa). */
  intervalMs: number;
  /** "Sin señal" cambia con el tiempo aunque no lleguen eventos: con este tick se pide un render. */
  tickMs: number;
  render: () => void;
  now?: () => number;
  timers?: Timers;
}

export interface RenderScheduler {
  /** Pide un render: muchas peticiones seguidas se juntan en UNA, como mucho cada `intervalMs`. Se ignora antes de `start()`. */
  request(): void;
  /** El mapa ya puede dibujar: renderiza ya y arranca el tick. */
  start(): void;
  dispose(): void;
}

/** Programa el `setData` del mapa: a lo sumo uno cada `intervalMs`, con todo lo acumulado entre dos renders. Reloj y timers inyectables. */
export function createRenderScheduler(options: RenderSchedulerOptions): RenderScheduler {
  const now = options.now ?? Date.now;
  const timers = options.timers ?? browserTimers;
  let started = false;
  let disposed = false;
  let timer: TimerId | undefined;
  let tick: TimerId | undefined;
  let lastRenderAt = 0;

  const run = () => {
    timer = undefined;
    if (disposed) return;
    lastRenderAt = now();
    options.render();
  };

  const request = () => {
    if (!started || disposed || timer !== undefined) return;
    timer = timers.setTimeout(run, Math.max(0, lastRenderAt + options.intervalMs - now()));
  };

  return {
    request,
    start() {
      if (started || disposed) return;
      started = true;
      run();
      tick = timers.setInterval(request, options.tickMs);
    },
    dispose() {
      disposed = true;
      if (timer !== undefined) timers.clearTimeout(timer);
      if (tick !== undefined) timers.clearInterval(tick);
      timer = undefined;
      tick = undefined;
    },
  };
}

export interface LoadWatchdogOptions {
  timeoutMs: number;
  onTimeout: () => void;
  timers?: Timers;
}

export interface LoadWatchdog {
  start(): void;
  /** La capa cargó: no se avisa. Idempotente. */
  markLoaded(): void;
  dispose(): void;
}

/** Avisa si algo (la capa de vehículos) no termina de cargar en `timeoutMs`, en vez de callar. */
export function createLoadWatchdog(options: LoadWatchdogOptions): LoadWatchdog {
  const timers = options.timers ?? browserTimers;
  let timer: TimerId | undefined;
  let loaded = false;
  const clear = () => {
    if (timer !== undefined) timers.clearTimeout(timer);
    timer = undefined;
  };
  return {
    start() {
      if (loaded || timer !== undefined) return;
      timer = timers.setTimeout(() => {
        timer = undefined;
        if (!loaded) options.onTimeout();
      }, options.timeoutMs);
    },
    markLoaded() {
      loaded = true;
      clear();
    },
    dispose: clear,
  };
}
