"use client";

import { ZONE_NAME_MAX_LENGTH, type ZoneFeatureTolerant, type ZoneKind } from "@fleet/contracts";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { useStore } from "zustand";
import { useFleet, useServices } from "../../app-services/services-context";
import { CollapsiblePanelView, PanelNote, usePanelOpen } from "../../components/panel";
import { panelError } from "../../components/panel-error";
import type { ZoneSaveState } from "./zone-controller";
import { canClose, distinctCount, type DrawingState } from "./zone-drawing";
import type { ZoneDrawingStore } from "./zone-drawing-store";
import { drawingIssueMessage, ZONE_KIND_OPTIONS, zoneKindLabel } from "./zone-errors";

const INPUT_CLASS = "block w-full rounded-md border border-line bg-raised px-3 py-2 text-ink placeholder:text-ink-muted read-only:opacity-60 aria-[invalid=true]:border-danger";
const FOCUS_CLASS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";
const BUTTON_CLASS = `rounded-md border border-line bg-raised px-3 py-1 font-medium text-ink hover:bg-canvas aria-disabled:cursor-not-allowed aria-disabled:opacity-60 ${FOCUS_CLASS}`;

export interface ZoneRow {
  readonly zoneId: string;
  readonly name: string;
  readonly kind: string;
}

const byName = new Intl.Collator("es-CO", { numeric: true, sensitivity: "base" });

/** Filas de la lista, ordenadas por nombre de forma natural. */
export function zoneRows(features: readonly Pick<ZoneFeatureTolerant, "properties">[] | undefined): ZoneRow[] {
  return (features ?? [])
    .map(({ properties }) => ({ zoneId: properties.zoneId, name: properties.name, kind: properties.kind }))
    .sort((a, b) => byName.compare(a.name, b.name));
}

/** Al volver a `idle` (guardó, canceló) el foco regresa a "Nueva zona": el botón que lo tenía desapareció al empezar. */
export const shouldFocusNewZone = (previous: DrawingState["phase"], next: DrawingState["phase"]): boolean => previous !== "idle" && next === "idle";

export const MAP_NOT_READY_MESSAGE = "El mapa aún no está listo (o no se pudo mostrar): no se pueden dibujar zonas.";

export interface ZonesViewProps {
  rows: readonly ZoneRow[];
  /** Las zonas aún no cargaron (primera carga). */
  loading: boolean;
  /** Error de carga de la lista (no se confunde con "sin zonas"). */
  error?: string | null;
  /** El mapa está listo para dibujar (sin WebGL o cargando, no). */
  mapReady?: boolean;
  drawing: DrawingState;
  save: ZoneSaveState;
  onStart: () => void;
  onAddAtCenter?: () => void;
  onUndo: () => void;
  onCancel: () => void;
  onClose: () => void;
  onSave: (name: string, kind: ZoneKind) => void;
  onClearFeedback: () => void;
}

/** Instrucciones y botones del dibujo (fase `drawing`). El dibujo requiere puntero; los botones y el texto sí son operables con teclado. */
function DrawingControls({ drawing, onUndo, onCancel, onClose, onAddAtCenter }: Pick<ZonesViewProps, "onUndo" | "onCancel" | "onClose" | "onAddAtCenter"> & { drawing: Extract<DrawingState, { phase: "drawing" }> }) {
  const helpRef = useRef<HTMLParagraphElement>(null);
  // Al entrar al modo dibujo el botón "Nueva zona" desaparece: el foco pasa a las instrucciones.
  useEffect(() => helpRef.current?.focus(), []);
  const count = drawing.vertices.length;
  const closable = canClose(drawing);
  return (
    <div className="space-y-3">
      <p ref={helpRef} tabIndex={-1} className={`text-ink ${FOCUS_CLASS}`}>
        Haz clic en el mapa para agregar vértices. Cierra el polígono con doble clic, haciendo clic en el primer punto o con el botón «Cerrar polígono». Esc cancela.
        Sin puntero, mueve el mapa con las flechas del teclado y usa «Agregar punto en el centro del mapa» (la cruz marca el centro).
      </p>
      <p role="status" className="text-ink-muted">
        {count === 1 ? "1 punto" : `${String(count)} puntos`} ({distinctCount(drawing.vertices)} distintos; mínimo 3).
      </p>
      {drawing.issue !== null && (
        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-danger">
          {drawingIssueMessage(drawing.issue)}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {onAddAtCenter !== undefined && (
          <button type="button" onClick={onAddAtCenter} className={BUTTON_CLASS}>
            Agregar punto en el centro del mapa
          </button>
        )}
        <button type="button" aria-disabled={count === 0} onClick={() => count > 0 && onUndo()} className={BUTTON_CLASS}>
          Deshacer punto
        </button>
        <button type="button" aria-disabled={!closable} onClick={() => closable && onClose()} className={BUTTON_CLASS}>
          Cerrar polígono
        </button>
        <button type="button" onClick={onCancel} className={BUTTON_CLASS}>
          Cancelar
        </button>
      </div>
    </div>
  );
}

/** Formulario con el polígono cerrado: nombre y tipo. Cada error se enlaza a su campo y se enfoca. */
function ZoneForm({ drawing, save, onSave, onUndo, onCancel, onClearFeedback }: Pick<ZonesViewProps, "save" | "onSave" | "onUndo" | "onCancel" | "onClearFeedback"> & { drawing: DrawingState }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ZoneKind>("customer");
  const nameId = useId();
  const nameErrorId = useId();
  const kindId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const saving = drawing.phase === "saving";

  // Al cerrar el polígono el foco va al nombre; tras un fallo, a donde se corrige (el nombre o el aviso general).
  useEffect(() => nameRef.current?.focus(), []);
  useEffect(() => {
    if (save.submit !== "failed") return;
    if (save.nameError !== null) nameRef.current?.focus();
    else if (save.error !== null) errorRef.current?.focus();
  }, [save.submit, save.nameError, save.error]);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!saving) onSave(name, kind);
  };

  return (
    <form className="space-y-3" onSubmit={onSubmit} noValidate aria-label="Nueva zona">
      <p className="text-ink-muted">Polígono cerrado. Ponle un nombre y un tipo para guardarlo.</p>
      <div className="space-y-1">
        <label htmlFor={nameId} className="block font-medium text-ink">
          Nombre
        </label>
        <input
          ref={nameRef}
          id={nameId}
          name="name"
          type="text"
          autoComplete="off"
          maxLength={ZONE_NAME_MAX_LENGTH * 2}
          required
          readOnly={saving}
          aria-invalid={save.nameError !== null}
          aria-describedby={save.nameError === null ? undefined : nameErrorId}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            onClearFeedback();
          }}
          placeholder="Bodega Fontibón"
          className={`${INPUT_CLASS} ${FOCUS_CLASS}`}
        />
        {save.nameError !== null && (
          <p id={nameErrorId} role="alert" className="text-xs text-danger">
            {save.nameError}
          </p>
        )}
      </div>
      <div className="space-y-1">
        <label htmlFor={kindId} className="block font-medium text-ink">
          Tipo
        </label>
        <select id={kindId} value={kind} disabled={saving} onChange={(event) => setKind(event.target.value as ZoneKind)} className={`${INPUT_CLASS} disabled:opacity-60`}>
          {ZONE_KIND_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          aria-disabled={saving}
          className={`rounded-md bg-ink px-4 py-2 font-medium text-raised hover:bg-ink/90 aria-disabled:cursor-not-allowed aria-disabled:opacity-60 ${FOCUS_CLASS}`}
        >
          {saving ? "Guardando…" : "Guardar"}
        </button>
        <button type="button" aria-disabled={saving} onClick={() => !saving && onUndo()} className={BUTTON_CLASS}>
          Deshacer punto
        </button>
        <button type="button" aria-disabled={saving} onClick={() => !saving && onCancel()} className={BUTTON_CLASS}>
          Cancelar
        </button>
      </div>
      {save.error !== null && (
        <p ref={errorRef} tabIndex={-1} role="alert" className={`rounded-md bg-danger-soft px-3 py-2 text-danger ${FOCUS_CLASS}`}>
          {save.error}
        </p>
      )}
    </form>
  );
}

/** Presentación del panel (sin store): lista de zonas, botón "Nueva zona", instrucciones del dibujo y formulario. */
export function ZonesView({ rows, loading, error = null, mapReady = true, drawing, save, onStart, onAddAtCenter, onUndo, onCancel, onClose, onSave, onClearFeedback }: ZonesViewProps) {
  const newZoneRef = useRef<HTMLButtonElement>(null);
  const previousPhase = useRef(drawing.phase);
  useEffect(() => {
    if (shouldFocusNewZone(previousPhase.current, drawing.phase)) newZoneRef.current?.focus();
    previousPhase.current = drawing.phase;
  }, [drawing.phase]);
  const noteId = useId();
  return (
    <div className="space-y-3">
      {/* Región viva siempre montada: un cambio de texto se anuncia, un nodo que aparece de golpe puede no anunciarse. */}
      <p role="status" className={save.createdName === null ? "sr-only" : "rounded-md bg-success-soft px-3 py-2 text-success"}>
        {save.createdName === null ? "" : `Zona «${save.createdName}» creada.`}
      </p>
      {drawing.phase === "idle" && (
        <div className="space-y-1">
          <button
            ref={newZoneRef}
            type="button"
            aria-disabled={!mapReady}
            aria-describedby={mapReady ? undefined : noteId}
            onClick={() => mapReady && onStart()}
            className={BUTTON_CLASS}
          >
            Nueva zona
          </button>
          {!mapReady && (
            <p id={noteId} className="text-xs text-ink-muted">
              {MAP_NOT_READY_MESSAGE}
            </p>
          )}
        </div>
      )}
      {drawing.phase === "drawing" && <DrawingControls drawing={drawing} onUndo={onUndo} onCancel={onCancel} onClose={onClose} onAddAtCenter={onAddAtCenter} />}
      {(drawing.phase === "closed" || drawing.phase === "saving") && (
        <ZoneForm drawing={drawing} save={save} onSave={onSave} onUndo={onUndo} onCancel={onCancel} onClearFeedback={onClearFeedback} />
      )}
      {loading && rows.length === 0 && <PanelNote>Cargando zonas…</PanelNote>}
      {!loading && error === null && rows.length === 0 && <PanelNote>Esta flota aún no tiene zonas.</PanelNote>}
      {rows.length > 0 && (
        <ul aria-label="Zonas" className="space-y-2">
          {rows.map((row) => (
            <li key={row.zoneId} className="flex items-baseline justify-between gap-2 rounded-lg border border-line bg-raised px-3 py-2">
              <span className="min-w-0 truncate font-medium text-ink">{row.name}</span>
              <span className="shrink-0 text-xs text-ink-muted">{zoneKindLabel(row.kind)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Zonas de la flota: lista (de `/v1/zones/geojson`, que ya carga el dashboard) y creación dibujando el polígono en el mapa. El estado del
 * dibujo vive en `zoneDrawingStore` (lo comparte con el mapa); al guardar, la zona entra al store de la flota y aparece en mapa y lista.
 */
export function ZonesPanel() {
  const { zoneController: controller, zoneDrawingStore } = useServices();
  const zones = useFleet((state) => state.zones);
  const drawing = useStore(zoneDrawingStore, (state) => state.drawing);
  const mapReady = useStore(zoneDrawingStore, (state: ZoneDrawingStore) => state.mapControl !== null);
  const save = useStore(controller.store);
  const [open, setOpen] = usePanelOpen("zones", false);
  const rows = useMemo(() => zoneRows(zones.data?.features), [zones.data]);

  // El controlador es de los servicios (lo corta el fin de sesión); aquí solo se suelta el dibujo a medias al salir del dashboard.
  useEffect(() => () => zoneDrawingStore.getState().reset(), [zoneDrawingStore]);

  return (
    <CollapsiblePanelView
      id="zones"
      title="Zonas"
      keepMounted
      count={zones.data === null ? undefined : String(zones.data.features.length)}
      error={panelError(zones, "Lista")}
      open={open}
      onToggle={() => setOpen(!open)}
    >
      <ZonesView
        rows={rows}
        loading={zones.data === null && zones.error === null}
        error={zones.error}
        mapReady={mapReady}
        drawing={drawing}
        save={save}
        onStart={() => {
          controller.clearFeedback();
          zoneDrawingStore.getState().start();
        }}
        onAddAtCenter={() => zoneDrawingStore.getState().addVertexAtCenter()}
        onUndo={() => zoneDrawingStore.getState().undo()}
        onCancel={() => {
          controller.clearFeedback();
          zoneDrawingStore.getState().cancel();
        }}
        onClose={() => zoneDrawingStore.getState().close()}
        onSave={(name, kind) => void controller.save(name, kind)}
        onClearFeedback={() => controller.clearFeedback()}
      />
    </CollapsiblePanelView>
  );
}
