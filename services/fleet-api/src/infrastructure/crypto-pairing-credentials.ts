import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { DEVICE_TOKEN_PREFIX, deviceTokenSchema, PAIRING_CODE_ALPHABET, PAIRING_CODE_LENGTH } from "@fleet/contracts";
import type { PairingCredentials } from "../application/ports.js";

/**
 * Secretos de la vinculación con el CSPRNG de `node:crypto`:
 * - código: `PAIRING_CODE_LENGTH` símbolos del alfabeto, cada uno con `randomInt` (uniforme, sin sesgo de módulo): 8 x 5 bits = 40 bits;
 * - token de dispositivo: `fdt_` + 32 bytes en base64url (256 bits, 43 caracteres), validado contra `deviceTokenSchema`.
 */
export function createCryptoPairingCredentials(): PairingCredentials {
  return {
    newPairingCode() {
      return Array.from({ length: PAIRING_CODE_LENGTH }, () => PAIRING_CODE_ALPHABET.charAt(randomInt(PAIRING_CODE_ALPHABET.length))).join("");
    },

    newDeviceToken() {
      return deviceTokenSchema.parse(`${DEVICE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`);
    },

    newDeviceId() {
      return randomUUID();
    },
  };
}
