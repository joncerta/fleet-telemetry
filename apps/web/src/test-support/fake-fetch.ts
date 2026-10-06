import type { FetchLike } from "../lib/api/http-client";

export interface PendingCall {
  readonly url: string;
  readonly init: RequestInit;
  /** La petición se canceló con su `AbortSignal`. */
  readonly aborted: () => boolean;
  respond(response: Response): void;
  fail(error: unknown): void;
}

/**
 * `fetch` falso y controlable: cada llamada queda pendiente hasta que el test la responde, y respeta el `AbortSignal` como el del
 * navegador (rechaza con `AbortError`). Así se prueba la cancelación y el orden de las respuestas.
 */
export function controllableFetch() {
  const calls: PendingCall[] = [];
  const fetch: FetchLike = (url, init) =>
    new Promise<Response>((resolve, reject) => {
      let aborted = false;
      init.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("La petición se canceló.", "AbortError"));
      });
      calls.push({ url, init, aborted: () => aborted, respond: resolve, fail: reject });
    });
  return {
    fetch,
    calls,
    last(): PendingCall {
      const call = calls[calls.length - 1];
      if (call === undefined) throw new Error("no hubo ninguna petición");
      return call;
    },
  };
}

export const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** Cuerpo JSON enviado (el cliente siempre manda un string). */
export const bodyOf = (init: RequestInit | undefined): unknown => (typeof init?.body === "string" ? JSON.parse(init.body) : undefined);
