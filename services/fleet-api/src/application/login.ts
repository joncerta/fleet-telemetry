import type { LoginRequest, Session } from "@fleet/contracts";
import type { AuthIdentity } from "../domain/identity.js";
import { InvalidCredentialsError } from "./errors.js";
import type { PasswordVerifier, UserRepository } from "./ports.js";

export interface LoginDependencies {
  users: UserRepository;
  passwords: PasswordVerifier;
  /**
   * Hash de una contraseña que nadie conoce, con los MISMOS parámetros que los hashes reales. Si el correo no existe se verifica
   * contra este, para que el tiempo de la respuesta no revele si el correo está registrado.
   */
  dummyPasswordHash: string;
}

export interface LoginResult {
  /** Identidad verificada: lo que se firma en la cookie de sesión. */
  identity: AuthIdentity;
  session: Session;
}

export type Login = (request: LoginRequest) => Promise<LoginResult>;

/**
 * Autentica con correo y contraseña. Un correo desconocido y una contraseña incorrecta dan el MISMO error y gastan el mismo trabajo
 * (siempre una verificación scrypt). El hash de la contraseña nunca sale de este caso de uso.
 */
export function createLogin(deps: LoginDependencies): Login {
  return async ({ email, password }) => {
    const account = await deps.users.findByEmail(email);
    const matches = await deps.passwords.verify(password, account?.passwordHash ?? deps.dummyPasswordHash);
    if (account === null || !matches) throw new InvalidCredentialsError();

    return {
      identity: { userId: account.userId, tenantId: account.tenantId },
      session: {
        user: { userId: account.userId, email: account.email, name: account.name },
        tenant: { tenantId: account.tenantId, name: account.tenantName },
      },
    };
  };
}
