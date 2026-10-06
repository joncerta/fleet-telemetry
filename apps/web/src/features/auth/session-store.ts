import type { Session } from "@fleet/contracts";
import { createStore, type StoreApi } from "zustand/vanilla";

/**
 * Sesión del usuario. La cookie es HttpOnly y de fleet-api: la web nunca ve el token, solo la identidad que devuelve
 * `/v1/auth/session` o el login (y la guarda solo en memoria). `unknown` = todavía no se preguntó.
 */
export type SessionStatus = "unknown" | "authenticated" | "anonymous";

export interface SessionStore {
  status: SessionStatus;
  session: Session | null;
  signedIn(session: Session): void;
  signedOut(): void;
}

export function createSessionStore(): StoreApi<SessionStore> {
  return createStore<SessionStore>()((set) => ({
    status: "unknown",
    session: null,
    signedIn: (session) => set({ status: "authenticated", session }),
    signedOut: () => set({ status: "anonymous", session: null }),
  }));
}
