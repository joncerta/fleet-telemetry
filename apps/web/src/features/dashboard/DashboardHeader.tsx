"use client";

import { useState } from "react";
import { useFleet, useServices, useSession } from "../../app-services/services-context";
import type { ConnectionStatus } from "../stream/fleet-stream-client";

const CONNECTION_LABELS: Record<ConnectionStatus, string> = {
  connecting: "Conectando…",
  live: "En vivo",
  reconnecting: "Reconectando…",
  disconnected: "Desconectado · reintentando",
};
// Mapas completos de clases por estado (nunca template strings).
const CONNECTION_DOT: Record<ConnectionStatus, string> = {
  connecting: "bg-status-no-signal",
  live: "bg-success",
  reconnecting: "bg-warning",
  disconnected: "bg-danger",
};
const CONNECTION_TEXT: Record<ConnectionStatus, string> = {
  connecting: "text-ink-muted",
  live: "text-success",
  reconnecting: "text-warning",
  disconnected: "text-danger",
};

export function ConnectionIndicator({ status }: { status: ConnectionStatus }) {
  return (
    <p role="status" aria-live="polite" className={`inline-flex items-center gap-2 font-medium ${CONNECTION_TEXT[status]}`}>
      <span aria-hidden="true" className={`size-2.5 rounded-full ${CONNECTION_DOT[status]}`} />
      <span>
        <span className="sr-only">Conexión: </span>
        {CONNECTION_LABELS[status]}
      </span>
    </p>
  );
}

export function DashboardHeader() {
  const services = useServices();
  const connection = useFleet((state) => state.connection);
  const tenantName = useSession((state) => state.session?.tenant.name ?? "");
  const userName = useSession((state) => state.session?.user.name ?? "");
  const [signingOut, setSigningOut] = useState(false);

  return (
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-raised px-4 py-3">
      <div className="flex items-baseline gap-3">
        <h1 className="text-base font-semibold text-ink">Fleet Telemetry</h1>
        <span className="text-ink-muted">{tenantName}</span>
      </div>
      <div className="flex items-center gap-4">
        <ConnectionIndicator status={connection} />
        <span className="hidden text-ink-muted sm:inline">{userName}</span>
        <button
          type="button"
          disabled={signingOut}
          onClick={() => {
            setSigningOut(true);
            void services.signOut();
          }}
          className="rounded-md border border-line px-3 py-1.5 font-medium text-ink hover:bg-canvas disabled:opacity-60"
        >
          {signingOut ? "Cerrando…" : "Cerrar sesión"}
        </button>
      </div>
    </header>
  );
}
