import { createStore, type StoreApi } from "zustand/vanilla";
import * as machine from "./zone-drawing";
import type { DrawingState, Position } from "./zone-drawing";

/** Lo que el panel necesita del mapa. */
export interface MapControl {
  center(): Position;
}

export interface ZoneDrawingStore {
  readonly drawing: DrawingState;
  start(): void;
  addVertex(vertex: Position): void;
  undo(): void;
  cancel(): void;
  /** Vuelve a `idle` incluso guardando (fin de sesión, desmontaje). */
  reset(): void;
  /** Lo registra el mapa al estar listo: sin él (cargando, sin WebGL) no se puede dibujar. */
  mapControl: MapControl | null;
  setMapControl(control: MapControl | null): void;
  /** Agrega un vértice en el centro del mapa (alternativa con teclado: el mapa se mueve con las flechas). */
  addVertexAtCenter(): void;
  close(): void;
  beginSave(): void;
  saveFailed(): void;
  saved(): void;
}

/**
 * Estado del dibujo compartido entre el mapa (que recibe los clics) y el panel "Zonas" (instrucciones y formulario). Solo conecta las
 * transiciones puras de `zone-drawing.ts`: si una acción no cambia nada devuelve el mismo estado y nadie se entera.
 */
export function createZoneDrawingStore(): StoreApi<ZoneDrawingStore> {
  return createStore<ZoneDrawingStore>()((set, get) => {
    const apply = (transition: (state: DrawingState) => DrawingState) => {
      const current = get().drawing;
      const next = transition(current);
      if (next !== current) set({ drawing: next });
    };
    return {
      drawing: machine.IDLE,
      start: () => apply(machine.start),
      addVertex: (vertex) => apply((state) => machine.addVertex(state, vertex)),
      undo: () => apply(machine.undo),
      cancel: () => apply(machine.cancel),
      reset: () => apply(machine.reset),
      mapControl: null,
      setMapControl: (control) => set({ mapControl: control }),
      addVertexAtCenter: () => {
        const center = get().mapControl?.center();
        if (center !== undefined) apply((state) => machine.addVertex(state, center));
      },
      close: () => apply(machine.close),
      beginSave: () => apply(machine.beginSave),
      saveFailed: () => apply(machine.saveFailed),
      saved: () => apply(machine.saved),
    };
  });
}

/** Hay un dibujo en curso (cualquier fase salvo `idle`): el mapa deja de seleccionar vehículos. */
export const isDrawing = (state: Pick<ZoneDrawingStore, "drawing">): boolean => state.drawing.phase !== "idle";
