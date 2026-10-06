"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useServices, useSession } from "../../app-services/services-context";
import { FullPageMessage } from "../../components/full-page-message";
import { UnauthorizedError } from "../../lib/api/http-client";

/**
 * Deja pasar solo con sesión. Al entrar pregunta a `/v1/auth/session` (la cookie es HttpOnly de otro origen: la web no puede leerla);
 * sin sesión, o cuando cualquier llamada o el stream respondan 401 más adelante, va al login.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { api, sessionStore } = useServices();
  const status = useSession((state) => state.status);
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (status !== "unknown") return;
    let cancelled = false;
    api.getSession().then(
      (session) => {
        if (!cancelled) sessionStore.getState().signedIn(session);
      },
      (error: unknown) => {
        if (cancelled) return;
        if (error instanceof UnauthorizedError) sessionStore.getState().signedOut();
        else setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, sessionStore, status, attempt]);

  useEffect(() => {
    if (status === "anonymous") router.replace("/login");
  }, [status, router]);

  if (status === "authenticated") return children;
  if (failed) {
    return (
      <FullPageMessage title="No se pudo verificar la sesión" description="El servidor no responde. Revisa tu conexión.">
        <button
          type="button"
          onClick={() => {
            setFailed(false);
            setAttempt((value) => value + 1);
          }}
          className="mt-4 rounded-md bg-ink px-4 py-2 font-medium text-raised hover:bg-ink/90"
        >
          Reintentar
        </button>
      </FullPageMessage>
    );
  }
  return <FullPageMessage title="Verificando la sesión…" busy />;
}
