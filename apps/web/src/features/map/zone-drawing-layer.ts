import type { AddLayerObject, GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import { mapMarker } from "../../design/tokens";
import { buildDraftFeatures } from "../zones/draft-features";
import { canClose, verticesOf } from "../zones/zone-drawing";
import { isDrawing, type ZoneDrawingStore } from "../zones/zone-drawing-store";
import type { StoreApi } from "zustand/vanilla";

export const DRAFT_SOURCE_ID = "fleet-zone-draft";
export const DRAFT_LAYER_IDS = { fill: "fleet-zone-draft-fill", line: "fleet-zone-draft-line", vertices: "fleet-zone-draft-vertices" } as const;

/** Distancia en píxeles al primer vértice a partir de la cual un clic cierra el polígono. */
const CLOSE_RADIUS_PX = 10;

const draftLayers: AddLayerObject[] = [
  { id: DRAFT_LAYER_IDS.fill, type: "fill", source: DRAFT_SOURCE_ID, filter: ["==", ["get", "part"], "fill"], paint: { "fill-color": mapMarker.selectedRing, "fill-opacity": 0.15 } },
  {
    id: DRAFT_LAYER_IDS.line,
    type: "line",
    source: DRAFT_SOURCE_ID,
    filter: ["==", ["get", "part"], "line"],
    paint: { "line-color": mapMarker.selectedRing, "line-width": 2, "line-dasharray": [2, 1] },
  },
  {
    id: DRAFT_LAYER_IDS.vertices,
    type: "circle",
    source: DRAFT_SOURCE_ID,
    filter: ["==", ["get", "part"], "vertex"],
    // El primer vértice es más grande: es el blanco para cerrar el polígono.
    paint: {
      "circle-radius": ["case", ["get", "first"], 7, 5],
      "circle-color": mapMarker.selectedRing,
      "circle-stroke-color": mapMarker.halo,
      "circle-stroke-width": 2,
    },
  },
];

/** Envuelve un handler del mapa para que se ignore mientras se dibuja una zona (los clics agregan vértices, no seleccionan vehículos). */
export const unlessDrawing =
  <Args extends unknown[]>(store: StoreApi<ZoneDrawingStore>, handler: (...args: Args) => void) =>
  (...args: Args): void => {
    if (!isDrawing(store.getState())) handler(...args);
  };

/** ¿El foco está en un campo editable? Con Esc en un campo (fuera del panel de zonas) no se cancela el dibujo. */
function isEditableOutsidePanel(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const editable = target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
  return editable && target.closest("#zones-body") === null;
}

/**
 * Capa de dibujo de zonas sobre el mapa: una fuente GeoJSON propia con línea, vértices y relleno de vista previa. En modo dibujo el clic
 * agrega un vértice (el doble clic o un clic en el primer vértice cierra el polígono), el cursor es una cruz y Esc cancela. El `setData`
 * se agrupa por fotograma (`requestAnimationFrame`), así que un `mousemove` por milisegundo no genera trabajo extra. Llamar tras el `load`
 * del mapa; devuelve la función que quita capas y listeners.
 */
export function attachZoneDrawing(map: MapLibreMap, store: StoreApi<ZoneDrawingStore>): () => void {
  map.addSource(DRAFT_SOURCE_ID, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  for (const layer of draftLayers) map.addLayer(layer);

  const phase = () => store.getState().drawing.phase;
  let pointer: readonly [number, number] | null = null;
  let frame = 0;

  const render = () => {
    frame = 0;
    // `buildDraftFeatures` produce GeoJSON válido; el tipo de MapLibre es más ancho que el nuestro.
    void map.getSource<GeoJSONSource>(DRAFT_SOURCE_ID)?.setData(buildDraftFeatures(store.getState().drawing, phase() === "drawing" ? pointer : null));
  };
  const schedule = () => {
    if (frame === 0) frame = requestAnimationFrame(render);
  };

  const applyMode = (drawing: boolean) => {
    map.getCanvas().style.cursor = drawing ? "crosshair" : "";
    // El doble clic cierra el polígono: no debe además acercar el mapa.
    if (drawing) map.doubleClickZoom.disable();
    else map.doubleClickZoom.enable();
  };

  const nearFirstVertex = (point: { x: number; y: number }): boolean => {
    const state = store.getState().drawing;
    const first = verticesOf(state)[0];
    if (first === undefined || !canClose(state)) return false;
    const projected = map.project([first[0], first[1]]);
    return Math.hypot(projected.x - point.x, projected.y - point.y) <= CLOSE_RADIUS_PX;
  };

  const onClick = map.on("click", (event) => {
    if (phase() !== "drawing") return;
    if (nearFirstVertex(event.point)) store.getState().close();
    else store.getState().addVertex([event.lngLat.lng, event.lngLat.lat]);
  });
  const onDoubleClick = map.on("dblclick", (event) => {
    if (phase() !== "drawing") return;
    event.preventDefault();
    store.getState().close();
  });
  const onMove = map.on("mousemove", (event) => {
    if (phase() !== "drawing" || verticesOf(store.getState().drawing).length === 0) return;
    pointer = [event.lngLat.lng, event.lngLat.lat];
    schedule();
  });
  const onOut = map.on("mouseout", () => {
    if (pointer === null) return;
    pointer = null;
    schedule();
  });
  const onKeyDown = (event: KeyboardEvent) => {
    // Solo mientras se coloca puntos: con el formulario abierto (anillo cerrado) Esc no debe borrar lo escrito.
    if (event.key !== "Escape" || phase() !== "drawing") return;
    // Esc que otro componente ya atendió (cerrar un menú) o que se escribe en un campo ajeno no cancela el dibujo.
    if (event.defaultPrevented || isEditableOutsidePanel(event.target)) return;
    store.getState().cancel();
  };
  window.addEventListener("keydown", onKeyDown);

  applyMode(phase() !== "idle");
  // Pinta ya lo que haya (un dibujo en curso al montar la capa).
  schedule();
  // Con la capa lista el panel puede ofrecer "Nueva zona" y "Agregar punto en el centro del mapa".
  store.getState().setMapControl({
    center: () => {
      const center = map.getCenter();
      return [center.lng, center.lat];
    },
  });
  const unsubscribe = store.subscribe((state, previous) => {
    if (state.drawing === previous.drawing) return;
    if ((state.drawing.phase === "idle") !== (previous.drawing.phase === "idle")) applyMode(state.drawing.phase !== "idle");
    if (state.drawing.phase !== "drawing") pointer = null;
    schedule();
  });

  return () => {
    unsubscribe();
    store.getState().setMapControl(null);
    window.removeEventListener("keydown", onKeyDown);
    for (const subscription of [onClick, onDoubleClick, onMove, onOut]) subscription.unsubscribe();
    if (frame !== 0) cancelAnimationFrame(frame);
    applyMode(false);
    for (const layer of Object.values(DRAFT_LAYER_IDS)) if (map.getLayer(layer) !== undefined) map.removeLayer(layer);
    if (map.getSource(DRAFT_SOURCE_ID) !== undefined) map.removeSource(DRAFT_SOURCE_ID);
  };
}
