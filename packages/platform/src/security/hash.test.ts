import { describe, expect, it } from "vitest";
import { sha256Hex } from "./hash.js";

describe("sha256Hex", () => {
  it("coincide con los vectores de prueba conocidos de sha256", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("devuelve 64 caracteres hexadecimales en minúscula y es determinista", () => {
    const token = "fdt_Zk3Qx9Wm2LpR7vTn4YbHc8DfJ1sAe6UoG0iNhXwVqKE";

    expect(sha256Hex(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex(token)).toBe(sha256Hex(token));
    expect(sha256Hex(`${token}x`)).not.toBe(sha256Hex(token));
  });
});
