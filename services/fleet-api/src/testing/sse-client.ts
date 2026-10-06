/** Soporte de los tests del stream: un cliente SSE mínimo sobre `fetch` con lectura de stream. No forma parte del build. */

export interface SseBlock {
  /** `id:` del evento (los comentarios no lo llevan). */
  id: string | undefined;
  event: string | undefined;
  data: string | undefined;
  /** `retry:` del bloque (ms que el navegador espera antes de reconectar). */
  retry: number | undefined;
  /** Texto de una línea de comentario (`: heartbeat`), sin los dos puntos ni el espacio. */
  comment: string | undefined;
}

/** Interpreta un bloque (lo que hay entre dos líneas en blanco) según el formato de SSE. */
export function parseSseBlock(block: string): SseBlock {
  const parsed: SseBlock = { id: undefined, event: undefined, data: undefined, retry: undefined, comment: undefined };
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) parsed.comment = line.slice(1).trim();
    else if (line.startsWith("id:")) parsed.id = line.slice(3).trim();
    else if (line.startsWith("event:")) parsed.event = line.slice(6).trim();
    else if (line.startsWith("retry:")) parsed.retry = Number(line.slice(6).trim());
    else if (line.startsWith("data:")) parsed.data = line.slice(5).trim();
  }
  return parsed;
}

export interface SseConnection {
  readonly response: Response;
  /** Siguiente bloque (evento o comentario). Rechaza si no llega en `timeoutMs` o si el servidor cerró el stream. */
  next(timeoutMs?: number): Promise<SseBlock>;
  /** `true` cuando el servidor (o el cliente) cerró el stream y no quedan bloques. Espera hasta `timeoutMs`. */
  closed(timeoutMs?: number): Promise<boolean>;
  /** Cierra la conexión del lado del cliente. */
  close(): void;
}

export async function openSse(url: string, headers: Record<string, string> = {}): Promise<SseConnection> {
  const controller = new AbortController();
  const response = await fetch(url, { headers, signal: controller.signal });
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  const queue: SseBlock[] = [];
  let ended = false;
  /** Quien espera el siguiente bloque (o el cierre). Un solo bucle de lectura alimenta la cola: un `next` que vence no se lleva bloques. */
  const waiters = new Set<() => void>();
  const wake = () => {
    for (const waiter of [...waiters]) waiter();
  };

  void (async () => {
    let buffer = "";
    try {
      while (reader !== undefined) {
        const chunk: { done: boolean; value?: unknown } = await reader.read();
        if (chunk.done) break;
        if (chunk.value instanceof Uint8Array) buffer += decoder.decode(chunk.value, { stream: true });
        for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
          queue.push(parseSseBlock(buffer.slice(0, end)));
          buffer = buffer.slice(end + 2);
        }
        wake();
      }
    } catch {
      // Cerrado por el cliente (abort) o por un error de red: es un cierre.
    }
    ended = true;
    wake();
  })();

  /** Resuelve cuando `ready()` es verdadero, o rechaza al vencer `timeoutMs`. */
  const until = (ready: () => boolean, timeoutMs: number, what: string): Promise<void> =>
    new Promise((resolve, reject) => {
      const check = () => {
        if (!ready()) return;
        cleanup();
        resolve();
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Se agotaron ${timeoutMs} ms esperando ${what}`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        waiters.delete(check);
      };
      waiters.add(check);
      check();
    });

  return {
    response,
    next: async (timeoutMs = 5_000) => {
      await until(() => queue.length > 0 || ended, timeoutMs, "el siguiente bloque del stream");
      const block = queue.shift();
      if (block === undefined) throw new Error("El stream se cerró antes del siguiente bloque");
      return block;
    },
    closed: (timeoutMs = 5_000) =>
      until(() => ended, timeoutMs, "el cierre del stream").then(
        () => true,
        () => false,
      ),
    close: () => controller.abort(),
  };
}
