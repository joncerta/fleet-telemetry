import { scryptSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DEFAULT_SCRYPT_PARAMS, hashPassword, verifyPassword } from "./password.js";

// Parámetros de prueba baratos: los de producción cuestan ~150 ms por derivación.
const CHEAP = { N: 1_024, r: 8, p: 1 } as const;

describe("hashPassword", () => {
  it("devuelve scrypt$N$r$p$sal$derivación con los parámetros codificados (el formato del CHECK de users.password_hash)", async () => {
    const hash = await hashPassword("una contraseña", CHEAP);

    expect(hash).toMatch(/^scrypt\$1024\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    // El mismo patrón que la migración 006.
    expect(hash).toMatch(/^scrypt\$[1-9][0-9]*\$[1-9][0-9]*\$[1-9][0-9]*\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  });

  it("usa una sal nueva cada vez: la misma contraseña da hashes distintos", async () => {
    expect(await hashPassword("igual", CHEAP)).not.toBe(await hashPassword("igual", CHEAP));
  });

  it("no contiene la contraseña en claro", async () => {
    expect(await hashPassword("secreto-que-no-debe-aparecer", CHEAP)).not.toContain("secreto");
  });

  it("los parámetros por defecto son los de OWASP (N=2^15, r=8, p=3) y funcionan con el tope de memoria de Node", async () => {
    expect(DEFAULT_SCRYPT_PARAMS).toEqual({ N: 32_768, r: 8, p: 3 });

    const hash = await hashPassword("por defecto");

    expect(hash.startsWith("scrypt$32768$8$3$")).toBe(true);
    await expect(verifyPassword("por defecto", hash)).resolves.toBe(true);
  });
});

describe("verifyPassword", () => {
  it("acepta la contraseña correcta y rechaza una incorrecta", async () => {
    const hash = await hashPassword("correcta", CHEAP);

    await expect(verifyPassword("correcta", hash)).resolves.toBe(true);
    await expect(verifyPassword("incorrecta", hash)).resolves.toBe(false);
    await expect(verifyPassword("", hash)).resolves.toBe(false);
    await expect(verifyPassword("correcta ", hash)).resolves.toBe(false);
  });

  it("lee los parámetros del hash: un hash con otros parámetros sigue verificando", async () => {
    const weak = await hashPassword("clave", { N: 1_024, r: 8, p: 1 });
    const stronger = await hashPassword("clave", { N: 2_048, r: 8, p: 2 });

    await expect(verifyPassword("clave", weak)).resolves.toBe(true);
    await expect(verifyPassword("clave", stronger)).resolves.toBe(true);
  });

  it("coincide con una derivación scrypt hecha a mano (formato interoperable, no inventado)", async () => {
    const salt = Buffer.from("0123456789abcdef");
    const key = scryptSync("clave", salt, 64, { N: 1_024, r: 8, p: 1 });
    const stored = `scrypt$1024$8$1$${salt.toString("base64url")}$${key.toString("base64url")}`;

    await expect(verifyPassword("clave", stored)).resolves.toBe(true);
    await expect(verifyPassword("otra", stored)).resolves.toBe(false);
  });

  it("normaliza a NFKC: la misma contraseña con otra composición Unicode es la misma", async () => {
    const hash = await hashPassword("contraseña", CHEAP); // ñ compuesta

    await expect(verifyPassword("contraseña", hash)).resolves.toBe(true); // n + tilde combinada
  });

  it.each([
    ["una contraseña en claro", "clave"],
    ["vacío", ""],
    ["otro algoritmo", "bcrypt$2b$12$abcdefghijklmnopqrstuv"],
    ["sin derivación", "scrypt$1024$8$1$c2FsdA"],
    ["parámetros no numéricos", "scrypt$mil$8$1$c2FsdA$ZGVyaXZlZA"],
    ["N que no es potencia de 2", "scrypt$1000$8$1$c2FsdA$ZGVyaXZlZA"],
    ["N por debajo del mínimo", "scrypt$512$8$1$c2FsdA$ZGVyaXZlZA"],
    ["N por encima del máximo (agotaría la memoria)", "scrypt$4294967296$8$1$c2FsdA$ZGVyaXZlZA"],
    ["r desmesurado", "scrypt$1024$1000$1$c2FsdA$ZGVyaXZlZA"],
    ["p desmesurado", "scrypt$1024$8$1000$c2FsdA$ZGVyaXZlZA"],
    ["memoria por encima del tope (N=2^20, r=16)", "scrypt$1048576$16$1$c2FsdA$ZGVyaXZlZA"],
    ["base64 estándar", "scrypt$1024$8$1$c2Fs+A$ZGVy/XZl"],
  ])("devuelve false, sin lanzar, ante un hash corrupto: %s", async (_label, stored) => {
    await expect(verifyPassword("clave", stored)).resolves.toBe(false);
  });
});
