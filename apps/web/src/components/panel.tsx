"use client";

import { useCallback, useId, useState, type ReactNode } from "react";
import { useSession } from "../app-services/services-context";
import type { PanelError } from "./panel-error";
import { browserStorage, panelStorageKey, readPanelPreferences, resolveOpen, writePanelPreference } from "./panel-state";

interface PanelViewProps {
  /** Id estable del panel (clave de la preferencia guardada y base de los ids del DOM). */
  id: string;
  title: string;
  /** Resumen que se ve aun con el panel cerrado ("6 activas", "15 con datos"). */
  count?: ReactNode;
  /** Fallo al cargar los datos del panel: se ve en el encabezado y se anuncia (un solo `role="alert"`) aun con el panel cerrado. */
  error?: PanelError | null;
  open: boolean;
  onToggle: () => void;
  /** Se muestra siempre, aun cerrado (p. ej. las regiones `aria-live`, que ocultas no anunciarían nada). */
  persistent?: ReactNode;
  /** Mantiene el contenido montado mientras está cerrado (conserva el estado de un formulario). Por defecto se desmonta: una lista de cientos de filas cerrada no debe renderizarse. */
  keepMounted?: boolean;
  /** Contenido secundario, solo visible abierto (p. ej. "Actualizado 10:32"). */
  aside?: ReactNode;
  children: ReactNode;
}

const hasContent = (node: ReactNode): boolean => node !== undefined && node !== null && node !== false && node !== "";

/** Presentación de un panel desplegable (sin store): encabezado clicable con `aria-expanded`/`aria-controls` y contador visible cerrado. */
export function CollapsiblePanelView({ id, title, count, error = null, open, onToggle, persistent, keepMounted = false, aside, children }: PanelViewProps) {
  const titleId = `${id}-title`;
  const bodyId = `${id}-body`;
  return (
    <section aria-labelledby={titleId} className="border-b border-line">
      <h2>
        <button
          type="button"
          id={`${id}-toggle`}
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={onToggle}
          className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left hover:bg-canvas focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
        >
          <span className="flex min-w-0 items-baseline gap-2">
            <span id={titleId} className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
              {title}
            </span>
            {error !== null ? (
              <span className="text-xs font-medium text-danger">· {error.summary}</span>
            ) : (
              hasContent(count) && <span className="text-xs font-medium text-ink tabular-nums">· {count}</span>
            )}
          </span>
          <span aria-hidden="true" className="shrink-0 text-ink-muted">
            {open ? "▾" : "▸"}
          </span>
        </button>
      </h2>
      {/* Fuera del cuerpo: cerrado también se ve y se anuncia, y se monta una sola vez mientras dure el fallo. */}
      {error !== null && (
        <div className="px-4 pb-3">
          <PanelNote tone="error">{error.message}</PanelNote>
        </div>
      )}
      {persistent}
      <div id={bodyId} hidden={!open} className="px-4 pb-4">
        {(open || keepMounted) && (
          <>
            {hasContent(aside) && <div className="mb-3 text-xs text-ink-muted">{aside}</div>}
            {children}
          </>
        )}
      </div>
    </section>
  );
}

/**
 * Estado abierto/cerrado de un panel, recordado por usuario en `localStorage`; si no se puede leer o escribir, vale el valor por defecto
 * y el cambio dura lo que la pestaña. `setOpen(open, false)` abre sin guardar (aperturas automáticas, que no son una decisión del usuario).
 * Solo se usa con sesión (el dashboard no se renderiza en el servidor).
 */
export function usePanelOpen(id: string, defaultOpen: boolean): readonly [boolean, (open: boolean, persist?: boolean) => void] {
  const userId = useSession((state) => state.session?.user.userId ?? "anonymous");
  const key = panelStorageKey(userId);
  const [open, setOpenState] = useState(() => resolveOpen(readPanelPreferences(browserStorage(), key), id, defaultOpen));
  const setOpen = useCallback(
    (next: boolean, persist = true) => {
      setOpenState(next);
      if (persist) writePanelPreference(browserStorage(), key, id, next);
    },
    [key, id],
  );
  return [open, setOpen];
}

type PanelProps = Omit<PanelViewProps, "open" | "onToggle"> & { defaultOpen: boolean };

/** Panel desplegable que gestiona su propio estado (con `usePanelOpen`). Si el padre necesita abrirlo, usa el hook y `CollapsiblePanelView`. */
export function Panel({ defaultOpen, ...view }: PanelProps) {
  const [open, setOpen] = usePanelOpen(view.id, defaultOpen);
  return <CollapsiblePanelView {...view} open={open} onToggle={() => setOpen(!open)} />;
}

/** Devuelve el foco al encabezado de un panel (p. ej. cuando el elemento enfocado dentro de él desaparece). */
export function focusPanelToggle(id: string): void {
  document.getElementById(`${id}-toggle`)?.focus();
}

/** Sub-desplegable dentro de un panel (p. ej. el historial de alertas), cerrado por defecto y sin persistencia. */
export function Disclosure({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  return (
    <div className="mt-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left font-medium text-ink-muted hover:bg-canvas focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
      >
        <span>
          {title} ({count})
        </span>
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
      </button>
      <div id={bodyId} hidden={!open} className="mt-2">
        {open && children}
      </div>
    </div>
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
