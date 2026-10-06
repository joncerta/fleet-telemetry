"use client";

import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { useFleet, useServerNow, useServices, useThrottledFleet } from "../../app-services/services-context";
import { Panel, PanelNote } from "../../components/panel";
import { StatusLabel } from "../../components/status";
import { formatAgo, formatInteger } from "../../lib/format";
import type { FleetStore } from "../fleet/fleet-store";
import { criticalZoneIdsOf, speedKmh } from "../fleet/vehicle-status";
import { vehicleRows, type VehicleRow } from "./vehicle-rows";

const selectVehicles = (state: FleetStore) => state.vehicles;

const VehicleItem = memo(function VehicleItem({ row, selected, onSelect }: { row: VehicleRow; selected: boolean; onSelect: (vehicleId: string) => void }) {
  const { vehicle, status, minutesSinceData } = row;
  const speed = status === "moving" ? speedKmh(vehicle.speedMps) : null;
  const buttonRef = useRef<HTMLButtonElement>(null);
  // Seleccionado desde el mapa: la lista lo trae a la vista (la lista es la alternativa accesible al canvas).
  useEffect(() => {
    if (selected) buttonRef.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  return (
    <li>
      <button
        ref={buttonRef}
        type="button"
        aria-pressed={selected}
        onClick={() => onSelect(vehicle.vehicleId)}
        className={
          selected
            ? "w-full rounded-lg border-2 border-focus bg-raised px-3 py-2 text-left"
            : "w-full rounded-lg border border-line bg-raised px-3 py-2 text-left hover:bg-canvas"
        }
      >
        <span className="flex items-center justify-between gap-2">
          <span className="font-semibold text-ink">{vehicle.plate}</span>
          {speed !== null && <span className="text-ink-muted tabular-nums">{formatInteger(speed)} km/h</span>}
        </span>
        <span className="mt-0.5 flex items-center justify-between gap-2 text-ink-muted">
          <StatusLabel status={status} />
          <span className="text-xs">{status === "no_signal" ? `Sin datos ${formatAgo(minutesSinceData)}` : `Último dato ${formatAgo(minutesSinceData)}`}</span>
        </span>
      </button>
    </li>
  );
}, sameRow);

/** Cada recálculo crea filas nuevas: se compara por contenido para no re-renderizar cientos de filas que no cambiaron. */
function sameRow(
  previous: { row: VehicleRow; selected: boolean; onSelect: (vehicleId: string) => void },
  next: { row: VehicleRow; selected: boolean; onSelect: (vehicleId: string) => void },
): boolean {
  return (
    previous.row.vehicle === next.row.vehicle &&
    previous.row.status === next.row.status &&
    previous.row.minutesSinceData === next.row.minutesSinceData &&
    previous.selected === next.selected &&
    previous.onSelect === next.onSelect
  );
}

/** Presentación (sin store). */
export function VehicleList({ rows, selectedId, onSelect }: { rows: readonly VehicleRow[]; selectedId: string | null; onSelect: (vehicleId: string) => void }) {
  if (rows.length === 0) return <PanelNote>Aún no hay vehículos con datos.</PanelNote>;
  return (
    <ul aria-label="Vehículos" className="space-y-2">
      {rows.map((row) => (
        <VehicleItem key={row.vehicle.vehicleId} row={row} selected={row.vehicle.vehicleId === selectedId} onSelect={onSelect} />
      ))}
    </ul>
  );
}

export function VehiclesPanel() {
  const { fleetStore } = useServices();
  // A la cadencia del mapa (500 ms), no con cada lote de eventos (200 ms): la lista tiene cientos de filas.
  const vehicles = useThrottledFleet(selectVehicles);
  const ready = useFleet((state) => state.ready);
  const zones = useFleet((state) => state.zones.data);
  const selectedId = useFleet((state) => state.selectedVehicleId);
  const total = useFleet((state) => state.summary.data?.vehicles.total ?? null);
  const serverNow = useServerNow();
  const criticalZoneIds = useMemo(() => criticalZoneIdsOf(zones), [zones]);
  const rows = useMemo(() => (serverNow === null ? [] : vehicleRows(vehicles, serverNow, criticalZoneIds)), [vehicles, serverNow, criticalZoneIds]);
  const select = useCallback((vehicleId: string) => fleetStore.getState().selectVehicle(vehicleId), [fleetStore]);
  const neverReported = total === null ? 0 : Math.max(0, total - rows.length);

  return (
    <Panel id="vehicles" title="Vehículos" defaultOpen={false} count={ready ? rows.length : undefined}>
      {ready ? <VehicleList rows={rows} selectedId={selectedId} onSelect={select} /> : <PanelNote>Esperando datos en vivo…</PanelNote>}
      {ready && neverReported > 0 && <p className="mt-2 text-xs text-ink-muted">{neverReported} vehículos aún no han reportado.</p>}
    </Panel>
  );
}
