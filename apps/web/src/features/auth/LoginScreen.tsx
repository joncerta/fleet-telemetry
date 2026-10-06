"use client";

import { loginRequestSchema } from "@fleet/contracts";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState, type FormEvent } from "react";
import { useServices, useSession } from "../../app-services/services-context";
import { loginErrorMessage } from "./login-errors";

/** Un campo de texto del formulario (un `File` no es texto). */
const textOf = (value: FormDataEntryValue | null): string => (typeof value === "string" ? value : "");

/** Ingreso con correo y contraseña. La API deja la cookie de sesión; la web solo guarda (en memoria) la identidad que devuelve. */
export function LoginScreen() {
  const { api, sessionStore } = useServices();
  const status = useSession((state) => state.status);
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const emailId = useId();
  const passwordId = useId();
  const errorId = useId();

  // Con sesión vigente no tiene sentido el formulario: al dashboard.
  useEffect(() => {
    if (status === "authenticated") router.replace("/");
  }, [status, router]);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const parsed = loginRequestSchema.safeParse({ email: textOf(form.get("email")).trim(), password: textOf(form.get("password")) });
    if (!parsed.success) {
      setError("Escribe un correo válido y tu contraseña.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const session = await api.login(parsed.data);
      sessionStore.getState().signedIn(session);
    } catch (loginError) {
      setError(loginErrorMessage(loginError));
      setSubmitting(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas p-6">
      <div className="w-full max-w-sm rounded-xl border border-line bg-raised p-8 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Fleet Telemetry</p>
        <h1 className="mt-1 text-xl font-semibold text-ink">Ingresa al portal</h1>
        <p className="mt-1 text-ink-muted">Monitorea tu flota en tiempo real.</p>

        <form
          aria-label="Ingreso"
          className="mt-6 space-y-4"
          onSubmit={(event) => void onSubmit(event)}
          noValidate
          aria-describedby={error === null ? undefined : errorId}
        >
          <div className="space-y-1">
            <label htmlFor={emailId} className="block font-medium text-ink">
              Correo
            </label>
            <input
              id={emailId}
              name="email"
              type="email"
              autoComplete="username"
              required
              disabled={submitting}
              className="block w-full rounded-md border border-line bg-raised px-3 py-2 text-ink placeholder:text-ink-muted disabled:opacity-60"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor={passwordId} className="block font-medium text-ink">
              Contraseña
            </label>
            <input
              id={passwordId}
              name="password"
              type="password"
              autoComplete="current-password"
              required
              disabled={submitting}
              className="block w-full rounded-md border border-line bg-raised px-3 py-2 text-ink disabled:opacity-60"
            />
          </div>

          {error !== null && (
            <p id={errorId} role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-danger">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-md bg-ink px-4 py-2 font-medium text-raised hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? "Ingresando…" : "Ingresar"}
          </button>
        </form>
      </div>
    </main>
  );
}
