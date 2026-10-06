/** Cliente SSE mínimo para los e2e del stream: `fetch` con lectura de stream y una cola de bloques. */

export interface SseBlock {
  /** `id:` del evento (los comentarios no lo llevan). */
  id: string | undefined;
  event: string | undefined;
  data: string | undefined;
  /** Texto de una línea de comentario (`: heartbeat`), sin los dos puntos ni el espacio. */
  comment: string | undefined;
}

/** Interpreta un bloque (lo que hay entre dos líneas en blanco) según el formato de SSE. */
export function parseSseBlock(block: string): SseBlock {
  const parsed: SseBlock = { id: undefined, event: undefined, data: undefined, comment: undefined };
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) parsed.comment = line.slice(1).trim();
    else if (line.startsWith("id:")) parsed.id = line.slice(3).trim();
    else if (line.startsWith("event:")) parsed.event = line.slice(6).trim();
    else if (line.startsWith("data:")) parsed.data = line.slice(5).trim();
  }
  return parsed;
}

export interface SseConnection {
  readonly response: Response;
  /** Todo lo recibido hasta ahora (bloques ya leídos con `next` incluidos), en orden. */
  readonly received: readonly SseBlock[];
  /** Siguiente bloque (evento o comentario). Rechaza si no llega en `timeoutMs` o si el stream se cerró. */
  next(timeoutMs?: number): Promise<SseBlock>;
  /** Lee bloques hasta que `predicate` acepte uno (lo devuelve). Rechaza con `what` si no llega en `timeoutMs`. */
  readUntil(what: string, predicate: (block: SseBlock) => boolean, timeoutMs?: number): Promise<SseBlock>;
  /** Cierra la conexión del lado del cliente. */
  close(): void;
}

export async function openSse(url: string, headers: Record<string, string> = {}): Promise<SseConnection> {
  const controller = new AbortController();
  const response = await fetch(url, { headers, signal: controller.signal });
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  const queue: SseBlock[] = [];
  const received: SseBlock[] = [];
  let ended = false;
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
          const block = parseSseBlock(buffer.slice(0, end));
          queue.push(block);
          received.push(block);
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

  const next = async (timeoutMs = 10_000): Promise<SseBlock> => {
    await until(() => queue.length > 0 || ended, timeoutMs, "el siguiente bloque del stream");
    const block = queue.shift();
    if (block === undefined) throw new Error("El stream se cerró antes del siguiente bloque");
    return block;
  };

  return {
    response,
    received,
    next,
    readUntil: async (what, predicate, timeoutMs = 30_000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`Se agotaron ${timeoutMs} ms esperando ${what}`);
        const block = await next(remaining).catch((error: unknown) => {
          throw new Error(`Esperando ${what}: ${error instanceof Error ? error.message : "error desconocido"}`);
        });
        if (predicate(block)) return block;
      }
    },
    close: () => controller.abort(),
  };
}
