import { ringOf, verticesOf, type DrawingState, type Position } from "./zone-drawing";

// `type` (no `interface`): las propiedades de GeoJSON son un índice de strings y solo un alias de tipo es asignable a él.
export type DraftFeature =
  | { type: "Feature"; geometry: { type: "Polygon"; coordinates: [number, number][][] }; properties: { part: "fill" } }
  | { type: "Feature"; geometry: { type: "LineString"; coordinates: [number, number][] }; properties: { part: "line" } }
  | { type: "Feature"; geometry: { type: "Point"; coordinates: [number, number] }; properties: { part: "vertex"; first: boolean } };

export type DraftFeatureCollection = { type: "FeatureCollection"; features: DraftFeature[] };

const copy = (position: Position): [number, number] => [position[0], position[1]];

/**
 * La vista previa del dibujo como UNA FeatureCollection (relleno, línea y vértices), en `[lng, lat]`. Con el cursor (`pointer`) la línea y el
 * relleno llegan hasta él (la "banda elástica"); con el anillo cerrado se pintan completos. Sin vértices no hay nada que pintar.
 */
export function buildDraftFeatures(state: DrawingState, pointer: Position | null): DraftFeatureCollection {
  const vertices = verticesOf(state);
  const features: DraftFeature[] = [];
  if (vertices.length === 0) return { type: "FeatureCollection", features };

  const ring = ringOf(state);
  // Cerrado: el anillo completo. Dibujando: los vértices más el cursor.
  const path = ring ?? [...vertices.map(copy), ...(pointer === null ? [] : [copy(pointer)])];
  if (path.length >= 3) {
    const polygon = ring ?? [...path, path[0] as [number, number]];
    features.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [polygon] }, properties: { part: "fill" } });
  }
  if (path.length >= 2) features.push({ type: "Feature", geometry: { type: "LineString", coordinates: path }, properties: { part: "line" } });
  vertices.forEach((vertex, index) => features.push({ type: "Feature", geometry: { type: "Point", coordinates: copy(vertex) }, properties: { part: "vertex", first: index === 0 } }));
  return { type: "FeatureCollection", features };
}
