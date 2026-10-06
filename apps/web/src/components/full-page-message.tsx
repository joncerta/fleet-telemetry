import type { ReactNode } from "react";

/** Pantalla completa de estado (cargando, error, verificando sesión). */
export function FullPageMessage({ title, description, busy = false, children }: { title: string; description?: string; busy?: boolean; children?: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas p-6">
      <div role={busy ? "status" : undefined} aria-busy={busy} className="max-w-sm text-center">
        <p className="text-base font-semibold text-ink">{title}</p>
        {description !== undefined && <p className="mt-1 text-ink-muted">{description}</p>}
        {children}
      </div>
    </main>
  );
}
