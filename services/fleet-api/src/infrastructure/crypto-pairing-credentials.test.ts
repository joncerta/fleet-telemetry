import { deviceTokenSchema, PAIRING_CODE_ALPHABET, PAIRING_CODE_LENGTH, pairingCodeSchema } from "@fleet/contracts";
import { describe, expect, it } from "vitest";
import { createCryptoPairingCredentials } from "./crypto-pairing-credentials.js";

const credentials = createCryptoPairingCredentials();

describe("createCryptoPairingCredentials", () => {
  it("el código tiene 8 caracteres del alfabeto sin ambiguos, y cumple el contrato", () => {
    for (let i = 0; i < 500; i++) {
      const code = credentials.newPairingCode();

      expect(code).toHaveLength(PAIRING_CODE_LENGTH);
      expect([...code].every((char) => PAIRING_CODE_ALPHABET.includes(char))).toBe(true);
      expect(code).not.toMatch(/[01IO]/);
      expect(pairingCodeSchema.shape.code.safeParse(code).success).toBe(true);
    }
  });

  it("usa los 32 símbolos del alfabeto de forma pareja (sin sesgo de módulo): todos aparecen y ninguno domina", () => {
    const counts = new Map<string, number>();
    const draws = 32_000;
    for (let i = 0; i < draws / PAIRING_CODE_LENGTH; i++) for (const char of credentials.newPairingCode()) counts.set(char, (counts.get(char) ?? 0) + 1);

    expect(counts.size).toBe(PAIRING_CODE_ALPHABET.length);
    // Esperado: 1000 por símbolo (desviación ~31). Entre 800 y 1200 es más de 6 desviaciones: una cota que un generador pareja nunca cruza.
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(800);
      expect(count).toBeLessThan(1_200);
    }
  });

  it("los códigos no se repiten (40 bits)", () => {
    const codes = new Set(Array.from({ length: 5_000 }, () => credentials.newPairingCode()));

    expect(codes.size).toBe(5_000);
  });

  it("el token cumple deviceTokenSchema (fdt_ + 43 caracteres base64url) y no se repite", () => {
    const tokens = Array.from({ length: 1_000 }, () => credentials.newDeviceToken());

    for (const token of tokens) expect(deviceTokenSchema.safeParse(token).success).toBe(true);
    expect(new Set(tokens).size).toBe(1_000);
  });

  it("el id del dispositivo es un uuid distinto cada vez", () => {
    const [a, b] = [credentials.newDeviceId(), credentials.newDeviceId()];

    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });
});
