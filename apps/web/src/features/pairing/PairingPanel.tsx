"use client";

import type { PairingCode } from "@fleet/contracts";
import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { shallow } from "zustand/shallow";
import { PANEL_THROTTLE_MS, useFleet, useServices, useThrottledFleet } from "../../app-services/services-context";
import { Panel, PanelNote } from "../../components/panel";
import { formatTime } from "../../lib/format";
import { msUntil, serverNowMs } from "../../lib/time/server-clock";
import type { FleetStore } from "../fleet/fleet-store";
import { pairingErrorMessage } from "./pairing-errors";

const byPlate = new Intl.Collator("es-CO", { numeric: true, sensitivity: "base" });

/** Solo id y placa de cada vehículo, como "id|placa": el selector devuelve strings para que la igualdad superficial baste. */
const selectVehicleKeys = (state: FleetStore): string[] => Object.values(state.vehicles).map((vehicle) => `${vehicle.vehicleId}|${vehicle.plate}`);

export interface PairingOption {
  vehicleId: string;
  plate: string;
}

/** Opciones del selector, ordenadas por placa, a partir de los pares "id|placa". */
export function pairingOptions(keys: readonly string[]): PairingOption[] {
  return keys
    .map((key) => {
      const separator = key.indexOf("|");
      return { vehicleId: key.slice(0, separator), plate: key.slice(separator + 1) };
    })
    .sort((a, b) => byPlate.compare(a.plate, b.plate));
}

/** El código generado, con su vencimiento. Al vencer se borra de la pantalla: es de un solo uso y de corta vida. */
function PairingResult({ code, plate }: { code: PairingCode; plate: string }) {
  const [expired, setExpired] = useState(false);
  // El vencimiento es hora del SERVIDOR: se mide con su desfase, no con el reloj del navegador (que puede estar adelantado o atrasado).
  const { fleetStore } = useServices();
  useEffect(() => {
    const serverNow = serverNowMs(fleetStore.getState().serverOffsetMs, Date.now());
    const id = setTimeout(() => setExpired(true), msUntil(code.expiresAt, serverNow));
    return () => clearTimeout(id);
  }, [code.expiresAt, fleetStore]);

  if (expired) return <PanelNote>El código para {plate} venció. Genera uno nuevo.</PanelNote>;
  return (
    <div className="rounded-lg border border-line bg-raised px-3 py-3" aria-live="polite">
      <p className="text-ink-muted">Código para {plate}</p>
      <p className="mt-1 font-mono text-2xl font-semibold tracking-widest text-ink">{code.code}</p>
      <p className="mt-1 text-ink-muted">
        Vence a las <time dateTime={code.expiresAt}>{formatTime(code.expiresAt)}</time>. Escríbelo en la app del conductor.
      </p>
    </div>
  );
}

/** Vinculación de un dispositivo: el operador genera un código para un vehículo de su flota (`POST /v1/devices/pairing-codes`). */
export function PairingPanel() {
  const { api } = useServices();
  const ready = useFleet((state) => state.ready);
  // Solo id y placa, a la cadencia del mapa: un cambio de posición no recalcula ni re-renderiza el selector.
  const keys = useThrottledFleet(selectVehicleKeys, PANEL_THROTTLE_MS, shallow);
  const options = useMemo(() => pairingOptions(keys), [keys]);
  const [vehicleId, setVehicleId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ code: PairingCode; plate: string } | null>(null);
  const selectId = useId();

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const option = options.find((candidate) => candidate.vehicleId === vehicleId);
    if (option === undefined) {
      setError("Elige un vehículo.");
      return;
    }
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const code = await api.createPairingCode(option.vehicleId);
      setResult({ code, plate: option.plate });
    } catch (pairingError) {
      setError(pairingErrorMessage(pairingError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Panel id="pairing-heading" title="Vincular dispositivo">
      {!ready ? (
        <PanelNote>Esperando datos en vivo…</PanelNote>
      ) : (
        <form className="space-y-3" onSubmit={(event) => void onSubmit(event)}>
          <div className="space-y-1">
            <label htmlFor={selectId} className="block font-medium text-ink">
              Vehículo
            </label>
            <select
              id={selectId}
              value={vehicleId}
              onChange={(event) => setVehicleId(event.target.value)}
              disabled={submitting}
              className="block w-full rounded-md border border-line bg-raised px-3 py-2 text-ink disabled:opacity-60"
            >
              <option value="">Elige un vehículo…</option>
              {options.map((option) => (
                <option key={option.vehicleId} value={option.vehicleId}>
                  {option.plate}
                </option>
              ))}
            </select>
            <p className="text-xs text-ink-muted">Solo aparecen los vehículos que ya enviaron datos.</p>
          </div>
          <button
            type="submit"
            disabled={submitting || vehicleId === ""}
            className="w-full rounded-md bg-ink px-4 py-2 font-medium text-raised hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? "Generando…" : "Generar código"}
          </button>
          {error !== null && <PanelNote tone="error">{error}</PanelNote>}
          {result !== null && <PairingResult key={result.code.code} code={result.code} plate={result.plate} />}
        </form>
      )}
    </Panel>
  );
}
