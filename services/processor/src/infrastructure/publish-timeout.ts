export class PublishTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`El broker no confirmó la publicación en ${timeoutMs} ms.`);
    this.name = "PublishTimeoutError";
  }
}

/**
 * Rechaza con `PublishTimeoutError` si `work` no termina a tiempo (todos los sub-lotes juntos). El temporizador se cancela
 * siempre. `work` recibe `isAbandoned`: tras el vencimiento devuelve `true` y debe dejar de iniciar envíos nuevos.
 */
export async function withTimeout(work: (isAbandoned: () => boolean) => Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  let abandoned = false;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abandoned = true;
      reject(new PublishTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  try {
    await Promise.race([work(() => abandoned), expired]);
  } finally {
    clearTimeout(timer);
  }
}
