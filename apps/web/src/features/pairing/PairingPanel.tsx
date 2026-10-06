"use client";

import { PLATE_MAX_LENGTH, VEHICLE_LABEL_MAX_LENGTH, type PairingCode, type VehicleCatalogItem } from "@fleet/contracts";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type RefObject } from "react";
import { useStore } from "zustand";
import { useServices } from "../../app-services/services-context";
import { CollapsiblePanelView, PanelNote, usePanelOpen } from "../../components/panel";
import { panelError } from "../../components/panel-error";
import { formatInteger, formatTime } from "../../lib/format";
import { msUntil, serverNowMs } from "../../lib/time/server-clock";
import { CATALOG_LIMIT, createPairingController, isCatalogTruncated, withoutDevice, type PairingState } from "./pairing-controller";
import { nextFormState } from "./pairing-form";

/** Valor de la opción que abre el formulario de alta. No es un id de vehículo (esos son UUID). */
export const NEW_VEHICLE = "new";

/** Texto de la opción del selector: `placa — nombre`, y se marca el que ya tiene dispositivo (la marca va en texto, no solo en color). */
export function catalogOptionLabel(item: Pick<VehicleCatalogItem, "plate" | "label" | "hasActiveDevice">): string {
  const base = item.label === null ? item.plate : `${item.plate} — ${item.label}`;
  return item.hasActiveDevice ? `${base} (con dispositivo)` : base;
}

/** Resumen del panel cerrado: "3 sin dispositivo" ("500+ sin dispositivo" si el catálogo está truncado). `undefined` mientras no hay catálogo. */
export function pairingCount(items: readonly VehicleCatalogItem[] | null): string | undefined {
  if (items === null) return undefined;
  return `${String(withoutDevice(items))}${isCatalogTruncated(items) ? "+" : ""} sin dispositivo`;
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

const INPUT_CLASS =
  "block w-full rounded-md border border-line bg-raised px-3 py-2 text-ink placeholder:text-ink-muted read-only:opacity-60 aria-[invalid=true]:border-danger";
const FOCUS_CLASS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";

export interface NewVehicleFieldsProps {
  plate: string;
  label: string;
  onPlateChange: (value: string) => void;
  onLabelChange: (value: string) => void;
  plateError: string | null;
  labelError: string | null;
  /** Mientras se envía: solo lectura (un `disabled` sacaría el foco del campo). */
  readOnly: boolean;
  plateRef?: RefObject<HTMLInputElement | null>;
  labelRef?: RefObject<HTMLInputElement | null>;
}

/** Campos del alta: cada error se enlaza a su campo con `aria-invalid` y `aria-describedby`. */
export function NewVehicleFields({ plate, label, onPlateChange, onLabelChange, plateError, labelError, readOnly, plateRef, labelRef }: NewVehicleFieldsProps) {
  const plateId = useId();
  const plateErrorId = useId();
  const labelId = useId();
  const labelErrorId = useId();
  return (
    <>
      <div className="space-y-1">
        <label htmlFor={plateId} className="block font-medium text-ink">
          Placa
        </label>
        <input
          ref={plateRef}
          id={plateId}
          name="plate"
          type="text"
          autoComplete="off"
          autoCapitalize="characters"
          maxLength={PLATE_MAX_LENGTH * 2}
          required
          readOnly={readOnly}
          aria-invalid={plateError !== null}
          aria-describedby={plateError === null ? undefined : plateErrorId}
          value={plate}
          onChange={(event) => onPlateChange(event.target.value)}
          placeholder="ABC123"
          className={`${INPUT_CLASS} ${FOCUS_CLASS}`}
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
          ref={labelRef}
          id={labelId}
          name="label"
          type="text"
          autoComplete="off"
          maxLength={VEHICLE_LABEL_MAX_LENGTH * 2}
          readOnly={readOnly}
          aria-invalid={labelError !== null}
          aria-describedby={labelError === null ? undefined : labelErrorId}
          value={label}
          onChange={(event) => onLabelChange(event.target.value)}
          placeholder="Camión de reparto 3"
          className={`${INPUT_CLASS} ${FOCUS_CLASS}`}
        />
        {labelError !== null && (
          <p id={labelErrorId} role="alert" className="text-xs text-danger">
            {labelError}
          </p>
        )}
      </div>
    </>
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

/** Presentación del panel (sin store): selector del catálogo, formulario "Nuevo vehículo" y el código generado. */
export function PairingView({ state, onPair, onCreate, onClearFeedback, onReloadCatalog, serverOffsetMs }: PairingViewProps) {
  const { catalog, submit, error, plateError, labelError, result, suggestedVehicleId } = state;
  const items = useMemo(() => catalog.data ?? [], [catalog.data]);
  const [selection, setSelection] = useState("");
  const [plate, setPlate] = useState("");
  const [label, setLabel] = useState("");
  const selectId = useId();
  const plateRef = useRef<HTMLInputElement>(null);
  const labelRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const submitting = submit === "submitting";
  const creating = selection === NEW_VEHICLE;
  const selected = items.find((item) => item.vehicleId === selection);
  const blocked = submitting || selection === "";

  // Reacciona a una sugerencia nueva del controlador (elegir el vehículo creado o el existente) y a un alta con código (limpiar el
  // formulario). La decisión es pura (`nextFormState`); aquí se ajusta durante el render, el patrón de React para derivar estado de props.
  const [seen, setSeen] = useState({ suggestedVehicleId, result });
  if (seen.suggestedVehicleId !== suggestedVehicleId || seen.result !== result) {
    const change = nextFormState(seen, { suggestedVehicleId, result }, creating);
    setSeen({ suggestedVehicleId, result });
    if (change.selection !== null) setSelection(change.selection);
    if (change.clearForm) {
      setPlate("");
      setLabel("");
    }
  }

  // Tras un fallo el foco va a donde se corrige: el primer campo inválido, o el aviso del servidor.
  useEffect(() => {
    if (submit !== "failed") return;
    if (plateError !== null) plateRef.current?.focus();
    else if (labelError !== null) labelRef.current?.focus();
    else if (error !== null) errorRef.current?.focus();
  }, [submit, plateError, labelError, error]);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (blocked) return;
    if (creating) onCreate(plate, label);
    else onPair(selection);
  };

  const noCatalog = catalog.data === null;
  const loadingCatalog = catalog.status === "loading";
  return (
    <div className="space-y-3">
      {noCatalog && catalog.error === null && <PanelNote>Cargando vehículos…</PanelNote>}
      {(!noCatalog || catalog.error !== null) && (
        <>
          <div>
            {/* El aviso de error vive en el encabezado del panel (`panelError`); aquí queda la acción de volver a leer. */}
            <button
              type="button"
              aria-disabled={loadingCatalog}
              onClick={() => {
                if (!loadingCatalog) onReloadCatalog();
              }}
              className={`rounded-md border border-line bg-raised px-3 py-1 font-medium text-ink hover:bg-canvas aria-disabled:opacity-60 ${FOCUS_CLASS}`}
            >
              {catalog.error !== null ? "Reintentar" : loadingCatalog ? "Actualizando…" : "Actualizar"}
            </button>
          </div>
          {isCatalogTruncated(items) && <PanelNote>Se muestran los primeros {formatInteger(CATALOG_LIMIT)} vehículos.</PanelNote>}
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
                className={`${INPUT_CLASS} disabled:opacity-60`}
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
                <p className="text-xs text-ink-muted">
                  Este vehículo ya tiene un dispositivo. Cuando el conductor canjee el código, el dispositivo actual dejará de enviar datos.
                </p>
              )}
            </div>

            {creating && (
              <NewVehicleFields
                plate={plate}
                label={label}
                onPlateChange={setPlate}
                onLabelChange={setLabel}
                plateError={plateError}
                labelError={labelError}
                readOnly={submitting}
                plateRef={plateRef}
                labelRef={labelRef}
              />
            )}

            <button
              type="submit"
              aria-disabled={blocked}
              className={`w-full rounded-md bg-ink px-4 py-2 font-medium text-raised hover:bg-ink/90 aria-disabled:cursor-not-allowed aria-disabled:opacity-60 ${FOCUS_CLASS}`}
            >
              {submitting ? (creating ? "Creando…" : "Generando…") : creating ? "Crear y generar código" : "Generar código"}
            </button>
            {error !== null && (
              <p ref={errorRef} tabIndex={-1} role="alert" className={`rounded-md bg-danger-soft px-3 py-2 text-danger ${FOCUS_CLASS}`}>
                {error}
              </p>
            )}
            {result !== null && <PairingResult key={result.code.code} code={result.code} plate={result.plate} serverOffsetMs={serverOffsetMs} />}
          </form>
        </>
      )}
    </div>
  );
}

/**
 * Vinculación de un dispositivo: el operador elige un vehículo del catálogo (o lo da de alta) y genera su código
 * (`POST /v1/vehicles`, `POST /v1/devices/pairing-codes`). Un controlador por montaje del dashboard: al cerrar sesión se desmonta y el
 * catálogo no lo ve el siguiente usuario. El catálogo se lee al montar (para el contador) y cada vez que se abre el panel.
 */
export function PairingPanel() {
  const { api, fleetStore } = useServices();
  const [controller] = useState(() => createPairingController(api));
  const state = useStore(controller.store);
  const [serverOffsetMs] = useState(() => () => fleetStore.getState().serverOffsetMs);
  const [open, setOpen] = usePanelOpen("pairing", false);
  const wasOpen = useRef(open);

  useEffect(() => () => controller.dispose(), [controller]);
  useEffect(() => {
    // Cerrar el panel no vuelve a leer; abrirlo sí (`hasActiveDevice` y el contador pueden haber cambiado).
    const closing = wasOpen.current && !open;
    wasOpen.current = open;
    if (!closing) void controller.loadCatalog();
  }, [controller, open]);

  return (
    <CollapsiblePanelView
      id="pairing"
      title="Vincular dispositivo"
      keepMounted
      count={pairingCount(state.catalog.data)}
      error={panelError(state.catalog, "Lista")}
      open={open}
      onToggle={() => setOpen(!open)}
    >
      <PairingView
        state={state}
        onPair={(vehicleId) => void controller.pair(vehicleId)}
        onCreate={(plate, label) => void controller.createAndPair(plate, label)}
        onClearFeedback={() => controller.clearFeedback()}
        onReloadCatalog={() => void controller.loadCatalog()}
        serverOffsetMs={serverOffsetMs}
      />
    </CollapsiblePanelView>
  );
}
