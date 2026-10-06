"use client";

import type { FleetSummary } from "@fleet/contracts";
import { useFleet } from "../../app-services/services-context";
import { Panel, PanelNote } from "../../components/panel";
import { formatInteger, formatTime } from "../../lib/format";
import type { Loadable } from "../../lib/loadable";

interface Kpi {
  label: string;
  value: (summary: FleetSummary) => number;
  tone: string;
}

const KPIS: readonly Kpi[] = [
  { label: "Total", value: (summary) => summary.vehicles.total, tone: "text-ink" },
  { label: "En movimiento", value: (summary) => summary.vehicles.moving, tone: "text-status-moving" },
  { label: "Detenidos", value: (summary) => summary.vehicles.stopped, tone: "text-status-stopped" },
  { label: "Sin señal", value: (summary) => summary.vehicles.noSignal, tone: "text-status-no-signal" },
  { label: "Alertas activas", value: (summary) => summary.activeAlerts, tone: "text-danger" },
];

/** Presentación: recibe el recurso por props. Los totales incluyen los vehículos que nunca reportaron (`/v1/summary`). */
export function KpiGrid({ summary }: { summary: Loadable<FleetSummary> }) {
  const data = summary.data;
  return (
    <>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-2" aria-busy={summary.status === "loading" && data === null}>
        {KPIS.map((kpi) => (
          <div key={kpi.label} className="rounded-lg border border-line bg-raised px-3 py-2">
            <dt className="text-xs text-ink-muted">{kpi.label}</dt>
            <dd className={`text-2xl font-semibold tabular-nums ${kpi.tone}`}>{data === null ? "—" : formatInteger(kpi.value(data))}</dd>
          </div>
        ))}
      </dl>
      {/* Por `error` (que `loading()` conserva), no por el estado: con la API caída, cada recarga no desmonta y vuelve a montar el aviso. */}
      {summary.error !== null && (
        <div className="mt-2">
          <PanelNote tone="error">
            {summary.error}
            {summary.updatedAt !== null && ` Datos de las ${formatTime(summary.updatedAt)}.`}
          </PanelNote>
        </div>
      )}
    </>
  );
}

export function KpiPanel() {
  const summary = useFleet((state) => state.summary);
  return (
    <Panel
      id="kpi-heading"
      title="Resumen de la flota"
      aside={summary.updatedAt !== null && <span className="text-xs text-ink-muted">Actualizado {formatTime(summary.updatedAt)}</span>}
    >
      <KpiGrid summary={summary} />
    </Panel>
  );
}
