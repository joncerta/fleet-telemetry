"use client";

import { useCallback, useMemo } from "react";
import { useFleet, useServerNow, useServices } from "../../app-services/services-context";
import { Panel, PanelNote } from "../../components/panel";
import { formatDuration, formatTime } from "../../lib/format";
import { STOPPED_QUERY } from "../fleet/fleet-sync";
import { stoppedRows, type StoppedRow } from "./stopped-view";

/** Presentación (sin store). */
export function StoppedList({ rows, onSelect }: { rows: readonly StoppedRow[]; onSelect: (vehicleId: string) => void }) {
  if (rows.length === 0) return <PanelNote>Ningún vehículo lleva más de {STOPPED_QUERY.minMinutes} min detenido en una zona crítica.</PanelNote>;
  return (
    <ul aria-label="Vehículos detenidos en zonas críticas" className="space-y-2">
      {rows.map(({ item, minutes }) => (
        <li key={item.vehicleId}>
          <button
            type="button"
            onClick={() => onSelect(item.vehicleId)}
            className="flex w-full items-center justify-between gap-2 rounded-lg border border-line bg-raised px-3 py-2 text-left hover:bg-canvas"
          >
            <span>
              <span className="block font-medium text-ink">{item.plate}</span>
              <span className="block text-ink-muted">{item.zone?.name ?? "Zona sin nombre"}</span>
            </span>
            <span className="font-semibold text-status-critical tabular-nums">{formatDuration(minutes)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function StoppedPanel() {
  const { fleetStore } = useServices();
  const stopped = useFleet((state) => state.stopped);
  const vehicles = useFleet((state) => state.vehicles);
  const serverNow = useServerNow();
  const rows = useMemo(
    () => (stopped.data === null || serverNow === null ? [] : stoppedRows(stopped.data.items, vehicles, serverNow, STOPPED_QUERY.minMinutes)),
    [stopped.data, vehicles, serverNow],
  );
  const select = useCallback((vehicleId: string) => fleetStore.getState().selectVehicle(vehicleId), [fleetStore]);

  return (
    <Panel id="stopped-heading" title={`Detenidos +${STOPPED_QUERY.minMinutes} min en zonas críticas`}>
      {stopped.data === null && stopped.status !== "error" && <PanelNote>Cargando…</PanelNote>}
      {stopped.data !== null && <StoppedList rows={rows} onSelect={select} />}
      {stopped.status === "error" && (
        <div className="mt-2">
          <PanelNote tone="error">
            {stopped.error}
            {stopped.updatedAt !== null && ` Lista de las ${formatTime(stopped.updatedAt)}.`}
          </PanelNote>
        </div>
      )}
    </Panel>
  );
}
