import { createHash } from "node:crypto";

/**
 * sha256 de un texto en hexadecimal minúscula (64 caracteres). Es el formato de `devices.token_hash`: el gateway
 * hashea el token que recibe con esta misma función para buscarlo, y `pnpm device:token` para guardarlo. El token en
 * claro nunca se guarda.
 */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
