export interface FixedWindowFailureCounterOptions {
  /** Fallos permitidos por key y ventana. Al llegar a este número la key queda bloqueada hasta que termine la ventana. */
  max: number;
  timeWindowMs: number;
  /** Tope de keys en memoria. Por defecto 100 000: con una IP por key son unos pocos MB. */
  maxKeys?: number;
}

export type FailureCheck = { blocked: false } | { blocked: true; retryAfterSeconds: number };

export interface FixedWindowFailureCounter {
  /** ¿La key superó el límite? Solo consulta: no cuenta. */
  check(key: string): FailureCheck;
  /** Cuenta un fallo de la key. */
  recordFailure(key: string): void;
  /** Keys con una ventana registrada (vencida o no); para los tests. */
  size(): number;
}

const DEFAULT_MAX_KEYS = 100_000;

interface Window {
  count: number;
  resetAtMs: number;
}

/**
 * Contador de fallos por key (la IP del cliente) en ventana fija, en memoria de cada réplica. Es la mitad "solo 401" del
 * límite por IP: `check` solo consulta y se llama cuando la autenticación ya falló; `recordFailure` cuenta ese fallo. Así
 * las peticiones correctas de una flota detrás de una misma IP (NAT, balanceador mal configurado) nunca consumen el límite.
 *
 * Con varias réplicas el límite efectivo es `max` por réplica; basta contra la fuerza bruta de tokens (de 256 bits) y no
 * justifica un almacén compartido.
 *
 * La memoria está acotada por `maxKeys`: al llenarse se descartan primero las ventanas vencidas y, si no alcanza, la key
 * más antigua. Un atacante que rote IPs puede así desalojar a otras, y lo único que se pierde es el conteo de 401.
 */
export function createFixedWindowFailureCounter(options: FixedWindowFailureCounterOptions): FixedWindowFailureCounter {
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  // El orden de inserción de un `Map` es el de las keys más antiguas primero.
  const windows = new Map<string, Window>();

  /**
   * Todas las ventanas duran lo mismo y una key solo se inserta al abrir su ventana, así que el orden de inserción del `Map`
   * es el de vencimiento: la purga se corta en la primera ventana vigente en vez de recorrerlo entero (O(n) por inserción con
   * el mapa lleno, justo cuando un atacante rota IPs). Si el reloj retrocede, una vencida puede quedar tras una vigente unas
   * ventanas más: `check` y `recordFailure` miran siempre el vencimiento de la key, así que solo se pierde algo de memoria.
   */
  function purgeExpired(nowMs: number): void {
    for (const [key, window] of windows) {
      if (nowMs < window.resetAtMs) return;
      windows.delete(key);
    }
  }

  return {
    check(key) {
      const nowMs = Date.now();
      const window = windows.get(key);
      if (window === undefined) return { blocked: false };
      if (nowMs >= window.resetAtMs) {
        windows.delete(key);
        return { blocked: false };
      }
      if (window.count < options.max) return { blocked: false };
      return { blocked: true, retryAfterSeconds: Math.max(1, Math.ceil((window.resetAtMs - nowMs) / 1_000)) };
    },

    recordFailure(key) {
      const nowMs = Date.now();
      const window = windows.get(key);
      if (window !== undefined && nowMs < window.resetAtMs) {
        window.count += 1;
        return;
      }
      windows.delete(key);
      if (windows.size >= maxKeys) {
        purgeExpired(nowMs);
        const oldest = windows.keys().next();
        if (windows.size >= maxKeys && oldest.done !== true) windows.delete(oldest.value);
      }
      windows.set(key, { count: 1, resetAtMs: nowMs + options.timeWindowMs });
    },

    size: () => windows.size,
  };
}
