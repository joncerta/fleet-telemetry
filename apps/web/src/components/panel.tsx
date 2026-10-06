import type { ReactNode } from "react";

/** Sección del panel lateral: un `section` con su encabezado, para que el lector de pantalla la navegue por regiones. */
export function Panel({ id, title, aside, children }: { id: string; title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="border-b border-line px-4 py-4">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 id={id} className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** Mensaje de estado dentro de un panel: cargando, vacío o error. */
export function PanelNote({ tone = "muted", children }: { tone?: "muted" | "error"; children: ReactNode }) {
  return tone === "error" ? (
    <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-danger">
      {children}
    </p>
  ) : (
    <p className="text-ink-muted">{children}</p>
  );
}
