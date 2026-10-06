import type { Session } from "@fleet/contracts";
import type { AuthIdentity } from "../domain/identity.js";
import { SessionInvalidError } from "./errors.js";
import type { UserRepository } from "./ports.js";

export type GetSession = (identity: AuthIdentity) => Promise<Session>;

/** Datos de la sesión de una identidad ya verificada. Si el usuario ya no existe en ese tenant, la sesión deja de valer. */
export function createGetSession(deps: { users: UserRepository }): GetSession {
  return async (identity) => {
    const session = await deps.users.findProfile(identity);
    if (session === null) throw new SessionInvalidError();
    return session;
  };
}
