import { randomUUID } from "node:crypto";
import { sessionSchema } from "@fleet/contracts";
import { describe, expect, it, vi } from "vitest";
import { InvalidCredentialsError } from "./errors.js";
import { createLogin } from "./login.js";
import type { PasswordVerifier, UserAccount, UserRepository } from "./ports.js";

const DUMMY = "scrypt$1024$8$1$ZHVtbXk$ZHVtbXk";
const account: UserAccount = {
  userId: randomUUID(),
  tenantId: randomUUID(),
  email: "operador@norte.test",
  name: "Operador Norte",
  passwordHash: "scrypt$1024$8$1$cmVhbA$cmVhbA",
  tenantName: "Flota Norte",
};

function makeLogin(found: UserAccount | null, passwordOk: boolean) {
  const findByEmail = vi.fn<UserRepository["findByEmail"]>().mockResolvedValue(found);
  const verify = vi.fn<PasswordVerifier["verify"]>().mockResolvedValue(passwordOk);
  const users: UserRepository = { findByEmail, findProfile: vi.fn() };
  return { login: createLogin({ users, passwords: { verify }, dummyPasswordHash: DUMMY }), findByEmail, verify };
}

describe("createLogin", () => {
  it("con credenciales correctas devuelve la identidad y una sesión que cumple el contrato, sin el hash", async () => {
    const { login, findByEmail, verify } = makeLogin(account, true);

    const result = await login({ email: "Operador@Norte.Test", password: "la-contraseña" });

    expect(findByEmail).toHaveBeenCalledWith("Operador@Norte.Test");
    expect(verify).toHaveBeenCalledWith("la-contraseña", account.passwordHash);
    expect(result.identity).toEqual({ userId: account.userId, tenantId: account.tenantId });
    expect(sessionSchema.parse(result.session)).toEqual({
      user: { userId: account.userId, email: account.email, name: account.name },
      tenant: { tenantId: account.tenantId, name: "Flota Norte" },
    });
    expect(JSON.stringify(result)).not.toContain(account.passwordHash);
  });

  it("una contraseña incorrecta lanza InvalidCredentialsError", async () => {
    const { login } = makeLogin(account, false);

    await expect(login({ email: account.email, password: "mala" })).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it("un correo que no existe verifica IGUAL contra el hash dummy (mismo trabajo) y lanza el mismo error", async () => {
    const { login, verify } = makeLogin(null, false);

    await expect(login({ email: "nadie@norte.test", password: "x" })).rejects.toBeInstanceOf(InvalidCredentialsError);

    expect(verify).toHaveBeenCalledOnce();
    expect(verify).toHaveBeenCalledWith("x", DUMMY);
  });

  it("aunque el verificador diera true para el hash dummy, un correo inexistente nunca entra", async () => {
    const { login } = makeLogin(null, true);

    await expect(login({ email: "nadie@norte.test", password: "x" })).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it("el error de credenciales no distingue el motivo ni incluye el correo", async () => {
    const unknown = await makeLogin(null, false).login({ email: "nadie@norte.test", password: "x" }).catch((e: unknown) => e);
    const wrong = await makeLogin(account, false).login({ email: account.email, password: "x" }).catch((e: unknown) => e);

    expect(unknown).toBeInstanceOf(InvalidCredentialsError);
    expect(wrong).toBeInstanceOf(InvalidCredentialsError);
    expect((unknown as Error).message).toBe((wrong as Error).message);
    expect((wrong as Error).message).not.toContain(account.email);
  });

  it("un fallo de la base se propaga: no se confunde con credenciales inválidas", async () => {
    const users: UserRepository = { findByEmail: () => Promise.reject(new Error("connect ECONNREFUSED")), findProfile: vi.fn() };
    const login = createLogin({ users, passwords: { verify: vi.fn() }, dummyPasswordHash: DUMMY });

    await expect(login({ email: account.email, password: "x" })).rejects.toThrow("ECONNREFUSED");
  });
});
