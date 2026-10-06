import { zoneCreateRequestSchema, type ZoneCreateRequest, type ZoneFeatureTolerant, type ZoneKind } from "@fleet/contracts";
import { ApiRequestError, NetworkError } from "../../lib/api/http-client";
import { createStore, type StoreApi } from "zustand/vanilla";
import { ringOf } from "./zone-drawing";
import type { ZoneDrawingStore } from "./zone-drawing-store";
import { zoneSaveFailure } from "./zone-errors";

/** `POST /v1/zones`: la respuesta ya viene validada (variante tolerante). */
export type CreateZone = (request: ZoneCreateRequest, signal?: AbortSignal) => Promise<ZoneFeatureTolerant>;

export interface ZoneSaveState {
  readonly submit: "idle" | "submitting" | "done" | "failed";
  /** Aviso general (no es del campo nombre). */
  readonly error: string | null;
  /** Error del campo nombre (validación local, 409 o 400): `aria-invalid` + `aria-describedby`, con el foco. */
  readonly nameError: string | null;
  /** Nombre de la zona recién creada: se anuncia ("Zona «x» creada.") hasta el próximo dibujo. */
  readonly createdName: string | null;
}

const INITIAL: ZoneSaveState = { submit: "idle", error: null, nameError: null, createdName: null };

export interface ZoneController {
  readonly store: StoreApi<ZoneSaveState>;
  /** Valida el nombre y envía el anillo cerrado del dibujo. Sin anillo cerrado no hace nada. */
  save(name: string, kind: ZoneKind): Promise<void>;
  /** Quita los avisos (al editar el formulario o salir del dibujo). */
  clearFeedback(): void;
  dispose(): void;
}

export interface ZoneControllerDeps {
  /** PUNTO DE CONEXIÓN con `POST /v1/zones` (`FleetApi.createZone`). */
  createZone: CreateZone;
  drawing: StoreApi<ZoneDrawingStore>;
  /** La zona ya existe en el servidor: el llamador la inserta en la lista y el mapa. */
  onCreated: (feature: ZoneFeatureTolerant) => void;
  /** La lista local puede estar desactualizada (409, corte de red): volver a leer las zonas. */
  onNeedsReload: () => void;
}

const isAbort = (error: unknown): boolean => error instanceof DOMException && error.name === "AbortError";

/** Orquesta el guardado de una zona, sin React: se prueba con un `createZone` falso. */
export function createZoneController({ createZone, drawing, onCreated, onNeedsReload }: ZoneControllerDeps): ZoneController {
  const store = createStore<ZoneSaveState>()(() => INITIAL);
  let request: AbortController | null = null;

  return {
    store,
    async save(rawName, kind) {
      if (store.getState().submit === "submitting") return;
      const ring = ringOf(drawing.getState().drawing);
      if (ring === null || drawing.getState().drawing.phase !== "closed") return;
      // El mismo esquema del servidor valida nombre, tipo y anillo antes de enviar (el nombre se recorta).
      const parsed = zoneCreateRequestSchema.safeParse({ name: rawName, kind, geometry: { type: "Polygon", coordinates: [ring] } });
      if (!parsed.success) {
        const nameIssue = parsed.error.issues.find((issue) => issue.path[0] === "name");
        const message = (nameIssue ?? parsed.error.issues[0])?.message ?? "Revisa la zona.";
        store.setState(nameIssue === undefined ? { submit: "failed", error: message, nameError: null } : { submit: "failed", error: null, nameError: message });
        return;
      }
      const current = new AbortController();
      request = current;
      store.setState({ submit: "submitting", error: null, nameError: null });
      drawing.getState().beginSave();
      let feature: ZoneFeatureTolerant;
      try {
        feature = await createZone(parsed.data, current.signal);
      } catch (error) {
        // `dispose` (fin de sesión) deja `request` en null: una respuesta tardía no toca nada.
        if (request !== current || isAbort(error)) return;
        request = null;
        const failure = zoneSaveFailure(error);
        drawing.getState().saveFailed();
        store.setState(failure.field === "name" ? { submit: "failed", error: null, nameError: failure.message } : { submit: "failed", error: failure.message, nameError: null });
        // Un 409 (otra pestaña creó el nombre) o un corte de red (¿se guardó?) dejan la lista local en duda: se vuelve a leer.
        if (error instanceof NetworkError || (error instanceof ApiRequestError && error.status === 409)) onNeedsReload();
        return;
      }
      if (request !== current) return;
      request = null;
      store.setState({ ...INITIAL, createdName: feature.properties.name });
      drawing.getState().saved();
      onCreated(feature);
    },
    clearFeedback() {
      if (store.getState().submit === "submitting") return;
      store.setState(INITIAL);
    },
    dispose() {
      // Sincrónico y reutilizable: aborta, descarta cualquier respuesta tardía (`request` en null) y no deja el dibujo trabado en `saving`.
      request?.abort();
      request = null;
      drawing.getState().reset();
      store.setState(INITIAL);
    },
  };
}
