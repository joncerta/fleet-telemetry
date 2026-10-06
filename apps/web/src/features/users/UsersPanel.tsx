"use client";

import type { UserListItem } from "@fleet/contracts";
import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { useServices } from "../../app-services/services-context";
import { CollapsiblePanelView, PanelNote, usePanelOpen } from "../../components/panel";
import { panelError } from "../../components/panel-error";
import { formatInteger } from "../../lib/format";
import type { Loadable } from "../../lib/loadable";
import { createUsersController, isUsersTruncated, USERS_LIMIT } from "./users-controller";

/**
 * Cuerpo del panel (sin store). El aviso de error sale de `error` (que `loading()` conserva entre recargas) y no del estado: al reintentar,
 * el `role="alert"` no se desmonta y el lector de pantalla no lo anuncia de nuevo. Nombre y correo son datos personales: solo se muestran.
 */
export function UsersBody({ users, onRetry }: { users: Pick<Loadable<readonly UserListItem[]>, "data" | "error" | "updatedAt">; onRetry: () => void }) {
  return (
    <>
      {users.data === null && users.error === null && <PanelNote>Cargando…</PanelNote>}
      {users.data !== null &&
        (users.data.length === 0 ? (
          <PanelNote>No hay usuarios en esta flota.</PanelNote>
        ) : (
          <>
            {isUsersTruncated(users.data) && <PanelNote>Se muestran los primeros {formatInteger(USERS_LIMIT)} usuarios.</PanelNote>}
            <ul aria-label="Usuarios" className="space-y-2">
              {users.data.map((user) => (
                <li key={user.userId} className="rounded-lg border border-line bg-raised px-3 py-2">
                  <span className="block truncate font-medium text-ink">{user.name}</span>
                  <span className="block truncate text-ink-muted">{user.email}</span>
                </li>
              ))}
            </ul>
          </>
        ))}
      {users.error !== null && (
        // El aviso vive en el encabezado del panel (`panelError`); aquí solo queda la acción.
        <div className="mt-2">
          <button type="button" onClick={onRetry} className="rounded-md border border-line bg-raised px-3 py-1 font-medium text-ink hover:bg-canvas">
            Reintentar
          </button>
        </div>
      )}
    </>
  );
}

/** Lista de solo lectura de los usuarios de la flota, ordenada por nombre. Un controlador por montaje del dashboard. */
export function UsersPanel() {
  const { api } = useServices();
  const [controller] = useState(() => createUsersController(api));
  const users = useStore(controller.store, (state) => state.users);

  const [open, setOpen] = usePanelOpen("users", false);

  useEffect(() => () => controller.dispose(), [controller]);
  // Nombre y correo son datos personales: no se piden hasta que alguien abre el panel (y solo la primera vez).
  useEffect(() => {
    if (open) void controller.loadOnce();
  }, [controller, open]);

  return (
    <CollapsiblePanelView
      id="users"
      title="Usuarios"
      count={users.data === null ? undefined : `${String(users.data.length)}${isUsersTruncated(users.data) ? "+" : ""}`}
      error={panelError(users, "Lista")}
      open={open}
      onToggle={() => setOpen(!open)}
    >
      <UsersBody users={users} onRetry={() => void controller.load()} />
    </CollapsiblePanelView>
  );
}
