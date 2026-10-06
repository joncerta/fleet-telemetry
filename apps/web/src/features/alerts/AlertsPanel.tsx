"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useFleet, useServices } from "../../app-services/services-context";
import { Disclosure, focusPanelToggle, Panel, PanelNote } from "../../components/panel";
import { formatTime } from "../../lib/format";
import type { FleetStore } from "../fleet/fleet-store";
import { createAlertAnnouncer } from "./alert-announcer";
import { ALERT_TYPE_LABELS, buildAlertFeed, countActiveAlerts, partitionAlertFeed, type AlertGroup, type AlertSeverity, type Announcement } from "./alert-feed";

/** Grupos visibles; el resto queda resumido en "y N más". */
const VISIBLE_GROUPS = 30;

const SEVERITY_LABEL: Record<AlertSeverity, string> = { critical: "Crítica", warning: "Advertencia", info: "Informativa" };
const SEVERITY_BADGE: Record<AlertSeverity, string> = {
  critical: "bg-danger-soft text-danger",
  warning: "bg-warning-soft text-warning",
  info: "bg-canvas text-ink-muted",
};
const SEVERITY_ICON: Record<AlertSeverity, string> = { critical: "▲", warning: "◆", info: "●" };

const PANEL_ID = "alerts";

const AlertRow = memo(function AlertRow({ group, onSelect }: { group: AlertGroup; onSelect: (vehicleId: string) => void }) {
  const { latest } = group;
  const buttonRef = useRef<HTMLButtonElement>(null);
  // Si la fila que tiene el foco desaparece (la alerta se resolvió y pasó al historial, que está cerrado), el foco caería a `body`: se
  // devuelve al encabezado del panel. Se hace al desmontar, antes de que el navegador quite el nodo.
  useLayoutEffect(() => {
    const button = buttonRef.current;
    return () => {
      if (button !== null && document.activeElement === button) focusPanelToggle(PANEL_ID);
    };
  }, []);
  return (
    <li>
      <button
        ref={buttonRef}
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

/** Lista de grupos con tope visible; el resto queda resumido en "y N más". */
function GroupList({ label, groups, onSelect }: { label: string; groups: readonly AlertGroup[]; onSelect: (vehicleId: string) => void }) {
  const hidden = groups.length - VISIBLE_GROUPS;
  return (
    <>
      <ul aria-label={label} className="space-y-2">
        {groups.slice(0, VISIBLE_GROUPS).map((group) => (
          <AlertRow key={group.key} group={group} onSelect={onSelect} />
        ))}
      </ul>
      {hidden > 0 && <p className="mt-2 text-ink-muted">y {hidden} más.</p>}
    </>
  );
}

/** Presentación (sin store): primero las activas; las resueltas, en un sub-desplegable "Historial" cerrado. */
export function AlertList({ groups, onSelect }: { groups: readonly AlertGroup[]; onSelect: (vehicleId: string) => void }) {
  if (groups.length === 0) return <PanelNote>Sin alertas.</PanelNote>;
  const { active, history } = partitionAlertFeed(groups);
  return (
    <>
      {active.length > 0 ? <GroupList label="Alertas" groups={active} onSelect={onSelect} /> : <PanelNote>Sin alertas activas.</PanelNote>}
      {history.length > 0 && (
        <Disclosure title="Historial" count={history.length}>
          <GroupList label="Historial resuelto" groups={history} onSelect={onSelect} />
        </Disclosure>
      )}
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

/** Lista de alertas: solo se monta con el panel abierto, así `buildAlertFeed` no corre por cada alerta mientras el panel está cerrado. */
function AlertsBody() {
  const { fleetStore } = useServices();
  const alerts = useFleet((state) => state.alerts);
  const ready = useFleet((state) => state.ready);
  const groups = useMemo(() => buildAlertFeed(Object.values(alerts)), [alerts]);
  const select = useCallback((vehicleId: string) => fleetStore.getState().selectVehicle(vehicleId), [fleetStore]);
  return ready ? <AlertList groups={groups} onSelect={select} /> : <PanelNote>Esperando datos en vivo…</PanelNote>;
}

/** Contador del encabezado: un número, calculado sin agrupar. */
const selectActiveCount = (state: FleetStore) => countActiveAlerts(Object.values(state.alerts));

export function AlertsPanel() {
  const ready = useFleet((state) => state.ready);
  const activeCount = useFleet(selectActiveCount);
  const announcement = useAlertAnnouncements();

  return (
    <Panel
      id={PANEL_ID}
      title="Alertas en vivo"
      defaultOpen
      count={ready ? `${activeCount} activas` : undefined}
      persistent={
        <>
          <div aria-live="polite" className="sr-only">
            {announcement.polite}
          </div>
          <div aria-live="assertive" className="sr-only">
            {announcement.assertive}
          </div>
        </>
      }
    >
      <AlertsBody />
    </Panel>
  );
}
