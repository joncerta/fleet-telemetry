import { createHash } from "node:crypto";
import { ALERT_ID_NAMESPACE } from "@fleet/contracts";
import type { AlertIdGenerator } from "../application/ports.js";

/** Bytes de un uuid (32 dígitos hexadecimales, con o sin guiones). */
function uuidBytes(uuid: string): Buffer {
  const hex = uuid.replaceAll("-", "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error("El namespace no es un uuid.");
  return Buffer.from(hex, "hex");
}

/**
 * uuid v5 (RFC 9562 §5.5): SHA-1 de `namespace || nombre (UTF-8)`, con los 16 primeros bytes, la versión 5 en el nibble alto del
 * byte 6 y la variante RFC 4122 en los dos bits altos del byte 8. Determinista: el mismo nombre y namespace dan siempre el mismo id.
 * SHA-1 aquí no es una defensa criptográfica, solo la función de identidad que fija el estándar.
 */
export function uuidV5(name: string, namespace: string): string {
  const hash = createHash("sha1").update(uuidBytes(namespace)).update(Buffer.from(name, "utf8")).digest().subarray(0, 16);
  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x50;
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80;
  const hex = hash.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** `AlertIdGenerator` con el namespace del contrato (`ALERT_ID_NAMESPACE`): processor y cualquier backfill deben coincidir. */
export function createAlertIdGenerator(): AlertIdGenerator {
  return { generate: (name) => uuidV5(name, ALERT_ID_NAMESPACE) };
}
