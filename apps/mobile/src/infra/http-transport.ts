import type { BatchTransport, TransportResponse } from "../core/sync-engine";
import { PARAMS } from "../core/params";

const BATCH_PATH = "/v1/telemetry/batches";

/** Transporte HTTP del lote. No loguea el cuerpo (lleva coordenadas) ni el token. */
export function createHttpTransport(options: { baseUrl: string; timeoutMs?: number; fetchImpl?: typeof fetch }): BatchTransport {
  const timeoutMs = options.timeoutMs ?? PARAMS.requestTimeoutMs;
  const doFetch = options.fetchImpl ?? fetch;
  const url = `${options.baseUrl.replace(/\/+$/, "")}${BATCH_PATH}`;

  return {
    async send({ body, token }): Promise<TransportResponse> {
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      try {
        const response = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const text = await response.text();
        let parsed: unknown;
        try {
          parsed = text === "" ? undefined : (JSON.parse(text) as unknown);
        } catch {
          parsed = undefined;
        }
        return { status: response.status, body: parsed, retryAfterHeader: response.headers.get("retry-after") };
      } catch {
        // Sin el mensaje original: el de red puede incluir la URL; solo importa distinguir timeout de red.
        const failure = new Error(timedOut ? "timeout" : "network");
        failure.name = timedOut ? "TimeoutError" : "NetworkError";
        throw failure;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function ingestBaseUrl(): string {
  // EXPO_PUBLIC_* no es secreto: solo la URL del gateway. Emulador Android: 10.0.2.2 es el host.
  const configured = process.env.EXPO_PUBLIC_INGEST_URL as string | undefined;
  return configured !== undefined && configured !== "" ? configured : "http://10.0.2.2:4001";
}
