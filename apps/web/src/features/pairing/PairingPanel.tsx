"use client";

import { VEHICLE_LABEL_MAX_LENGTH, type PairingCode, type VehicleCatalogItem } from "@fleet/contracts";
import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { useStore } from "zustand";
import { useServices } from "../../app-services/services-context";
import { Panel, PanelNote } from "../../components/panel";
import { panelError } from "../../components/panel-error";
import { formatTime } from "../../lib/format";
import { msUntil, serverNowMs } from "../../lib/time/server-clock";
import { createPairingController, withoutDevice, type PairingState } from "./pairing-controller";

/** Valor de la opción que abre el formulario de alta. No es un id de vehículo (esos son UUID). */
export const NEW_VEHICLE = "new";

/** Texto de la opción del selector: `placa — nombre`, y se marca el que ya tiene dispositivo (la marca va en texto, no solo en color). */
export function catalogOptionLabel(item: Pick<VehicleCatalogItem, "plate" | "label" | "hasActiveDevice">): string {
  const base = item.label === null ? item.plate : `${item.plate} — ${item.label}`;
  return item.hasActiveDevice ? `${base} (con dispositivo)` : base;
}

/** Resumen del panel cerrado: "3 sin dispositivo". `undefined` mientras no hay catálogo (no se muestra un 0 falso). */
export function pairingCount(items: readonly VehicleCatalogItem[] | null): string | undefined {
  return items === null ? undefined : `${String(withoutDevice(items))} sin dispositivo`;
}

/** El código generado, con su vencimiento. Al vencer se borra de la pantalla: es de un solo uso y de corta vida. */
function PairingResult({ code, plate, serverOffsetMs }: { code: PairingCode; plate: string; serverOffsetMs: () => number }) {
  const [expired, setExpired] = useState(false);
  // El vencimiento es hora del SERVIDOR: se mide con su desfase, no con el reloj del navegador (que puede estar adelantado o atrasado).
  useEffect(() => {
    const serverNow = serverNowMs(serverOffsetMs(), Date.now());
    const id = setTimeout(() => setExpired(true), msUntil(code.expiresAt, serverNow));
    return () => clearTimeout(id);
  }, [code.expiresAt, serverOffsetMs]);

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

export interface PairingViewProps {
  state: PairingState;
  onPair: (vehicleId: string) => void;
  onCreate: (plate: string, label: string) => void;
  onClearFeedback: () => void;
  onReloadCatalog: () => void;
  serverOffsetMs: () => number;
}

const INPUT_CLASS = "block w-full rounded-md border border-line bg-raised px-3 py-2 text-ink placeholder:text-ink-muted disabled:opacity-60";

/** Presentación del panel (sin store): selector del catálogo, formulario "Nuevo vehículo" y el código generado. */
export function PairingView({ state, onPair, onCreate, onClearFeedback, onReloadCatalog, serverOffsetMs }: PairingViewProps) {
  const { catalog, submit, error, plateError, labelError, result, createdVehicleId } = state;
  const items = useMemo(() => catalog.data ?? [], [catalog.data]);
  const [selection, setSelection] = useState("");
  const [plate, setPlate] = useState("");
  const [label, setLabel] = useState("");
  const selectId = useId();
  const plateId = useId();
  const plateErrorId = useId();
  const labelId = useId();
  const labelErrorId = useId();
  const submitting = submit === "submitting";
  const creating = selection === NEW_VEHICLE;
  const selected = items.find((item) => item.vehicleId === selection);

  // Vehículo creado pero sin código: se elige en la lista para reintentar (ya está en el catálogo refrescado).
  // (Ver el ajuste durante el render, abajo.)
  // Alta con código: el formulario queda limpio para el siguiente; el código se ve en el resultado. Se ajusta durante el render
  // (patrón de React para derivar estado de props) y no en un efecto, que renderizaría dos veces con el valor viejo.
  const [seen, setSeen] = useState({ createdVehicleId, result });
  if (seen.createdVehicleId !== createdVehicleId || seen.result !== result) {
    setSeen({ createdVehicleId, result });
    if (createdVehicleId !== null && seen.createdVehicleId !== createdVehicleId) setSelection(createdVehicleId);
    if (result !== null && seen.result !== result && creating) {
      setPlate("");
      setLabel("");
    }
  }

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (creating) onCreate(plate, label);
    else if (selection !== "") onPair(selection);
  };

  const noCatalog = catalog.data === null;
  return (
    <div className="space-y-3">
      {noCatalog && catalog.error === null && <PanelNote>Cargando vehículos…</PanelNote>}
      {catalog.error !== null && (
        // El aviso vive en el encabezado del panel (`panelError`); aquí solo queda la acción.
        <div>
          <button type="button" onClick={onReloadCatalog} className="rounded-md border border-line bg-raised px-3 py-1 font-medium text-ink hover:bg-canvas">
            Reintentar
          </button>
        </div>
      )}
      {(!noCatalog || catalog.error !== null) && (
        <form className="space-y-3" onSubmit={onSubmit} noValidate>
          <div className="space-y-1">
            <label htmlFor={selectId} className="block font-medium text-ink">
              Vehículo
            </label>
            <select
              id={selectId}
              value={selection}
              onChange={(event) => {
                setSelection(event.target.value);
                onClearFeedback();
              }}
              disabled={submitting}
              className={INPUT_CLASS}
            >
              <option value="">Elige un vehículo…</option>
              <option value={NEW_VEHICLE}>Nuevo vehículo</option>
              {items.map((item) => (
                <option key={item.vehicleId} value={item.vehicleId}>
                  {catalogOptionLabel(item)}
                </option>
              ))}
            </select>
            {selected?.hasActiveDevice === true && (
              <p className="text-xs text-ink-muted">Este vehículo ya tiene un dispositivo vinculado. Generar un código nuevo reemplazará el dispositivo actual.</p>
            )}
          </div>

          {creating && (
            <>
              <div className="space-y-1">
                <label htmlFor={plateId} className="block font-medium text-ink">
                  Placa
                </label>
                <input
                  id={plateId}
                  name="plate"
                  type="text"
                  autoComplete="off"
                  autoCapitalize="characters"
                  maxLength={32}
                  required
                  aria-invalid={plateError !== null}
                  aria-describedby={plateError === null ? undefined : plateErrorId}
                  value={plate}
                  onChange={(event) => setPlate(event.target.value)}
                  disabled={submitting}
                  placeholder="ABC123"
                  className={INPUT_CLASS}
                />
                {plateError !== null && (
                  <p id={plateErrorId} role="alert" className="text-xs text-danger">
                    {plateError}
                  </p>
                )}
              </div>
              <div className="space-y-1">
                <label htmlFor={labelId} className="block font-medium text-ink">
                  Nombre <span className="font-normal text-ink-muted">(opcional)</span>
                </label>
                <input
                  id={labelId}
                  name="label"
                  type="text"
                  autoComplete="off"
                  maxLength={VEHICLE_LABEL_MAX_LENGTH}
                  aria-invalid={labelError !== null}
                  aria-describedby={labelError === null ? undefined : labelErrorId}
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  disabled={submitting}
                  placeholder="Camión de reparto 3"
                  className={INPUT_CLASS}
                />
                {labelError !== null && (
                  <p id={labelErrorId} role="alert" className="text-xs text-danger">
                    {labelError}
                  </p>
                )}
              </div>
            </>
          )}

          <button
            type="submit"
            disabled={submitting || selection === ""}
            className="w-full rounded-md bg-ink px-4 py-2 font-medium text-raised hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? (creating ? "Creando…" : "Generando…") : creating ? "Crear y generar código" : "Generar código"}
          </button>
          {error !== null && <PanelNote tone="error">{error}</PanelNote>}
          {result !== null && <PairingResult key={result.code.code} code={result.code} plate={result.plate} serverOffsetMs={serverOffsetMs} />}
        </form>
      )}
    </div>
  );
}

/**
 * Vinculación de un dispositivo: el operador elige un vehículo del catálogo (o lo da de alta) y genera su código
 * (`POST /v1/vehicles`, `POST /v1/devices/pairing-codes`). Un controlador por montaje del dashboard: al cerrar sesión se desmonta y el
 * catálogo no lo ve el siguiente usuario.
 */
export function PairingPanel() {
  const { api, fleetStore } = useServices();
  const [controller] = useState(() => createPairingController(api));
  const state = useStore(controller.store);
  const [serverOffsetMs] = useState(() => () => fleetStore.getState().serverOffsetMs);

  useEffect(() => {
    void controller.loadCatalog();
    return () => controller.dispose();
  }, [controller]);

  return (
    <Panel id="pairing" title="Vincular dispositivo" defaultOpen={false} keepMounted
      count={pairingCount(state.catalog.data)}
      error={panelError(state.catalog, "Lista")}
    >
      <PairingView
        state={state}
        onPair={(vehicleId) => void controller.pair(vehicleId)}
        onCreate={(plate, label) => void controller.createAndPair(plate, label)}
        onClearFeedback={() => controller.clearFeedback()}
        onReloadCatalog={() => void controller.loadCatalog()}
        serverOffsetMs={serverOffsetMs}
      />
    </Panel>
  );
}
