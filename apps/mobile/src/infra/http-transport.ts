import { resolveBaseUrl } from "../core/endpoints";
import { PARAMS } from "../core/params";
import type { PairTransport } from "../core/pairing";
import type { BatchTransport, TransportResponse } from "../core/sync-engine";

const BATCH_PATH = "/v1/telemetry/batches";
const PAIR_PATH = "/v1/devices/pair";

/**
 * POST JSON. No lanza por un 4xx/5xx: solo por red o timeout (con `TimeoutError`/`NetworkError`, sin el mensaje original,
 * que puede incluir la URL). No loguea el cuerpo (coordenadas, código o token).
 */
export async function postJson(args: {
  url: string;
  body: unknown;
  headers?: Record<string, string>;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): Promise<TransportResponse> {
  const doFetch = args.fetchImpl ?? fetch;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, args.timeoutMs);
  try {
    const response = await doFetch(args.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...args.headers },
      body: JSON.stringify(args.body),
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
    const failure = new Error(timedOut ? "timeout" : "network");
    failure.name = timedOut ? "TimeoutError" : "NetworkError";
    throw failure;
  } finally {
    clearTimeout(timer);
  }
}

export function createHttpTransport(options: { baseUrl: string; timeoutMs?: number; fetchImpl?: typeof fetch }): BatchTransport {
  const url = `${options.baseUrl.replace(/\/+$/, "")}${BATCH_PATH}`;
  return {
    send: ({ body, token }) =>
      postJson({
        url,
        body,
        headers: { authorization: `Bearer ${token}` },
        timeoutMs: options.timeoutMs ?? PARAMS.requestTimeoutMs,
        ...(options.fetchImpl !== undefined && { fetchImpl: options.fetchImpl }),
      }),
  };
}

/** La URL se resuelve en cada llamada: una build sin `EXPO_PUBLIC_FLEET_API_URL` falla al vincular, no al arrancar. */
export function createPairTransport(options: { baseUrl?: () => string; timeoutMs?: number; fetchImpl?: typeof fetch } = {}): PairTransport {
  const baseUrl = options.baseUrl ?? fleetApiBaseUrl;
  return {
    pair: (body) =>
      postJson({
        url: `${baseUrl().replace(/\/+$/, "")}${PAIR_PATH}`,
        body,
        timeoutMs: options.timeoutMs ?? PARAMS.requestTimeoutMs,
        ...(options.fetchImpl !== undefined && { fetchImpl: options.fetchImpl }),
      }),
  };
}

// EXPO_PUBLIC_* no es secreto y debe referenciarse literalmente para que Metro lo inyecte en el bundle.
export function ingestBaseUrl(): string {
  return resolveBaseUrl({
    variable: "EXPO_PUBLIC_INGEST_URL",
    configured: process.env.EXPO_PUBLIC_INGEST_URL as string | undefined,
    isDev: __DEV__,
    devDefault: "http://10.0.2.2:4001",
  });
}

export function fleetApiBaseUrl(): string {
  return resolveBaseUrl({
    variable: "EXPO_PUBLIC_FLEET_API_URL",
    configured: process.env.EXPO_PUBLIC_FLEET_API_URL as string | undefined,
    isDev: __DEV__,
    devDefault: "http://10.0.2.2:4002",
  });
}
