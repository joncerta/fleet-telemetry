"use client";

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useFleet, useServices } from "../../app-services/services-context";
import { Panel, PanelNote } from "../../components/panel";
import { formatTime } from "../../lib/format";
import { createAlertAnnouncer } from "./alert-announcer";
import { ALERT_TYPE_LABELS, buildAlertFeed, type AlertGroup, type AlertSeverity, type Announcement } from "./alert-feed";

/** Grupos visibles; el resto queda resumido en "y N más". */
const VISIBLE_GROUPS = 30;

const SEVERITY_LABEL: Record<AlertSeverity, string> = { critical: "Crítica", warning: "Advertencia", info: "Informativa" };
const SEVERITY_BADGE: Record<AlertSeverity, string> = {
  critical: "bg-danger-soft text-danger",
  warning: "bg-warning-soft text-warning",
  info: "bg-canvas text-ink-muted",
};
const SEVERITY_ICON: Record<AlertSeverity, string> = { critical: "▲", warning: "◆", info: "●" };

const AlertRow = memo(function AlertRow({ group, onSelect }: { group: AlertGroup; onSelect: (vehicleId: string) => void }) {
  const { latest } = group;
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(group.vehicleId)}
        className="w-full rounded-lg border border-line bg-raised px-3 py-2 text-left hover:bg-canvas"
      >
        <span className="flex items-center justify-between gap-2">
          <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-semibold ${SEVERITY_BADGE[group.severity]}`}>
            <span aria-hidden="true">{SEVERITY_ICON[group.severity]}</span>
            {SEVERITY_LABEL[group.severity]}
          </span>
          <span className="text-xs text-ink-muted tabular-nums">{formatTime(latest.raisedAt)}</span>
        </span>
        <span className="mt-1 block font-medium text-ink">
          {ALERT_TYPE_LABELS[group.type]} · {group.plate}
          {group.count > 1 && <span className="ml-1 text-ink-muted">×{group.count}</span>}
        </span>
        <span className="block text-ink-muted">
          {latest.zoneName !== null && `${latest.zoneName} · `}
          {group.active ? "Activa" : `Resuelta${latest.resolvedAt === null ? "" : ` a las ${formatTime(latest.resolvedAt)}`}`}
        </span>
      </button>
    </li>
  );
});

/** Presentación de la lista de alertas (sin store). */
export function AlertList({ groups, onSelect }: { groups: readonly AlertGroup[]; onSelect: (vehicleId: string) => void }) {
  if (groups.length === 0) return <PanelNote>Sin alertas.</PanelNote>;
  const hidden = groups.length - VISIBLE_GROUPS;
  return (
    <>
      <ul aria-label="Alertas" className="space-y-2">
        {groups.slice(0, VISIBLE_GROUPS).map((group) => (
          <AlertRow key={group.key} group={group} onSelect={onSelect} />
        ))}
      </ul>
      {hidden > 0 && <p className="mt-2 text-ink-muted">y {hidden} más.</p>}
    </>
  );
}

/** Anuncia al lector de pantalla las alertas nuevas que llegan en vivo (no las que ya estaban al conectar). */
function useAlertAnnouncements(): Announcement {
  const { fleetStore } = useServices();
  const [announcement, setAnnouncement] = useState<Announcement>({ polite: null, assertive: null });

  useEffect(() => {
    const announcer = createAlertAnnouncer();
    announcer.observe(fleetStore.getState());
    return fleetStore.subscribe((state) => {
      const next = announcer.observe(state);
      if (next !== null) setAnnouncement(next);
    });
  }, [fleetStore]);

  return announcement;
}

export function AlertsPanel() {
  const { fleetStore } = useServices();
  const alerts = useFleet((state) => state.alerts);
  const ready = useFleet((state) => state.ready);
  const groups = useMemo(() => buildAlertFeed(Object.values(alerts)), [alerts]);
  const activeCount = useMemo(() => Object.values(alerts).filter((alert) => alert.resolvedAt === null).length, [alerts]);
  const announcement = useAlertAnnouncements();
  const select = useCallback((vehicleId: string) => fleetStore.getState().selectVehicle(vehicleId), [fleetStore]);

  return (
    <Panel id="alerts-heading" title="Alertas en vivo" aside={ready && <span className="text-xs text-ink-muted">{activeCount} activas</span>}>
      <div aria-live="polite" className="sr-only">
        {announcement.polite}
      </div>
      <div aria-live="assertive" className="sr-only">
        {announcement.assertive}
      </div>
      {ready ? <AlertList groups={groups} onSelect={select} /> : <PanelNote>Esperando datos en vivo…</PanelNote>}
    </Panel>
  );
}
