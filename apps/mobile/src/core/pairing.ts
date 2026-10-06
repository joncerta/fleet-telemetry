import {
  PAIRING_CODE_ALPHABET,
  devicePairRequestSchema,
  devicePairResponseTolerantSchema,
  type DevicePairRequest,
} from "@fleet/contracts";
import { parseRetryAfter } from "./backoff";
import type { CredentialsStore } from "./credentials";
import type { TransportResponse } from "./sync-engine";

export interface PairTransport {
  /** Lanza con red caída o timeout. */
  pair(body: DevicePairRequest): Promise<TransportResponse>;
}

export type PairError =
  | "code_format"
  | "invalid_code"
  | "rate_limited"
  | "server"
  | "network"
  | "bad_response"
  | "config";

export type PairResult =
  | { readonly ok: true }
  /** `retryAfterMs`: solo con `rate_limited`. Nunca lleva el código ni el token. */
  | { readonly ok: false; readonly error: PairError; readonly retryAfterMs?: number };

/** Lo que teclea el conductor: mayúsculas, sin espacios ni guiones. */
export function normalizePairingCode(raw: string): string {
  return raw.replace(/[\s-]/g, "").toUpperCase();
}

const ALPHABET = new Set(PAIRING_CODE_ALPHABET);
/** Para el campo de texto: descarta lo que no está en el alfabeto y recorta al largo del código. */
export function filterPairingInput(raw: string, length: number): string {
  return [...normalizePairingCode(raw)].filter((c) => ALPHABET.has(c)).slice(0, length).join("");
}

/**
 * Canjea el código de vinculación en `POST /v1/devices/pair` y guarda las credenciales.
 * - 201: guarda `{ token, vehicleId }` (la placa es un dato personal: no se guarda ni se registra);
 * - 400/404: código inválido, usado o vencido;
 * - 429: respeta `Retry-After`.
 * No toca el turno ni el tracking: re-vincular no puede terminar el turno. Reanuda el sync con `onPaired`.
 */
export async function pairDevice(args: {
  rawCode: string;
  transport: PairTransport;
  credentials: Pick<CredentialsStore, "save">;
  onPaired?: () => Promise<void>;
  nowMs: number;
}): Promise<PairResult> {
  const request = devicePairRequestSchema.safeParse({ code: normalizePairingCode(args.rawCode) });
  if (!request.success) return { ok: false, error: "code_format" };

  let response: TransportResponse;
  try {
    response = await args.transport.pair(request.data);
  } catch (error) {
    // Una URL mal configurada (EndpointConfigError) se distingue de una falla de red.
    return { ok: false, error: error instanceof Error && error.name === "EndpointConfigError" ? "config" : "network" };
  }

  if (response.status === 201) {
    const parsed = devicePairResponseTolerantSchema.safeParse(response.body);
    if (!parsed.success) return { ok: false, error: "bad_response" };
    await args.credentials.save({ token: parsed.data.deviceToken, vehicleId: parsed.data.vehicleId });
    await args.onPaired?.();
    return { ok: true };
  }
  if (response.status === 400 || response.status === 404) return { ok: false, error: "invalid_code" };
  if (response.status === 429) {
    const retryAfterMs = parseRetryAfter(response.retryAfterHeader, args.nowMs);
    return { ok: false, error: "rate_limited", ...(retryAfterMs !== null && { retryAfterMs }) };
  }
  return { ok: false, error: "server" };
}
