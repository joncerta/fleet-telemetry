import { isInsideBoundingBox, ZONE_MAX_VERTICES } from "@fleet/contracts";

/** Posición `[lng, lat]` (regla 13: longitud primero). */
export type Position = readonly [number, number];

/** Por qué se rechazó la última acción; la UI lo dice con texto. Un clic repetido en el mismo punto se ignora en silencio. */
export type DrawingIssue = "self_intersection" | "max_vertices" | "outside_colombia" | "zero_area" | "too_few_vertices";

/**
 * Máquina de estados del dibujo de una zona (pura, sin React ni MapLibre).
 * idle -> drawing -> closed -> saving -> idle. Guardar con error vuelve a `closed`.
 * Las validaciones locales son para la UX; el servidor es la fuente de verdad (geometría, bbox de Colombia, nombre).
 */
export type DrawingState =
  | { readonly phase: "idle" }
  | { readonly phase: "drawing"; readonly vertices: readonly Position[]; readonly issue: DrawingIssue | null }
  | { readonly phase: "closed"; readonly vertices: readonly Position[]; readonly ring: readonly Position[] }
  | { readonly phase: "saving"; readonly vertices: readonly Position[]; readonly ring: readonly Position[] };

export const IDLE: DrawingState = { phase: "idle" };

/** Mínimo de vértices distintos para un polígono. */
export const MIN_DISTINCT_VERTICES = 3;

/** Dentro del rectángulo de Colombia (`COLOMBIA_BBOX` por defecto en `isInsideBoundingBox`, los bordes cuentan como dentro). El servidor vuelve a validarlo. */
export const isInsideColombia = (vertex: Position): boolean => isInsideBoundingBox(vertex[0], vertex[1]);

const same = (a: Position, b: Position): boolean => a[0] === b[0] && a[1] === b[1];

export const distinctCount = (vertices: readonly Position[]): number => new Set(vertices.map((vertex) => `${String(vertex[0])},${String(vertex[1])}`)).size;

/** Área con signo (fórmula del zapato) del anillo implícito de `vertices`, en grados². 0 si son colineales. */
export function signedArea(vertices: readonly Position[]): number {
  let sum = 0;
  for (let i = 0; i < vertices.length; i += 1) {
    const a = vertices[i];
    const b = vertices[(i + 1) % vertices.length];
    if (a !== undefined && b !== undefined) sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

/** Por debajo de esta área (grados², ~1 cm²) un polígono es degenerado (todos los puntos colineales o casi). */
const MIN_AREA = 1e-14;

/** Signo del giro a→b→c (producto cruz): >0 antihorario, <0 horario, 0 colineales. */
const orientation = (a: Position, b: Position, c: Position): number => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

const within = (a: number, b: number, value: number): boolean => value >= Math.min(a, b) && value <= Math.max(a, b);

/** Un punto colineal con a-b cae dentro del segmento (caja contenedora). */
const onSegment = (a: Position, b: Position, p: Position): boolean => within(a[0], b[0], p[0]) && within(a[1], b[1], p[1]);

/** Los segmentos a-b y c-d se tocan o se cruzan (incluye tocarse en un extremo y traslaparse colineales). */
export function segmentsIntersect(a: Position, b: Position, c: Position, d: Position): boolean {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
  if (o1 === 0 && onSegment(a, b, c)) return true;
  if (o2 === 0 && onSegment(a, b, d)) return true;
  if (o3 === 0 && onSegment(c, d, a)) return true;
  return o4 === 0 && onSegment(c, d, b);
}

/**
 * ¿El segmento `from`→`to` (con `from` = último vértice de `path`) cruza o toca la poligonal `path`, salvo el segmento contiguo?
 * El contiguo comparte `from`: solo es inválido si `to` se pliega sobre él. Al cerrar (`closing`), el primer segmento comparte `to`.
 */
function crossesPath(path: readonly Position[], from: Position, to: Position, closing: boolean): boolean {
  const lastSegment = path.length - 2;
  for (let i = 0; i <= lastSegment; i += 1) {
    const a = path[i];
    const b = path[i + 1];
    if (a === undefined || b === undefined) continue;
    if (i === lastSegment) {
      // Pliegue: `to` colineal con el tramo contiguo y del mismo lado que su inicio (volver sobre él, pase o no de `a`).
      // Seguir recto (colineal pero del lado opuesto) es válido.
      if (orientation(a, b, to) === 0 && (a[0] - from[0]) * (to[0] - from[0]) + (a[1] - from[1]) * (to[1] - from[1]) > 0) return true;
      continue;
    }
    if (i === 0 && closing) continue;
    if (segmentsIntersect(a, b, from, to)) return true;
  }
  return false;
}

/** Un anillo (abierto o cerrado, sin repetir el primer vértice al final) se cruza consigo mismo: dos segmentos no contiguos se tocan. O(n²). */
export function hasSelfIntersection(vertices: readonly Position[]): boolean {
  const n = vertices.length;
  for (let i = 0; i < n; i += 1) {
    const a = vertices[i];
    const b = vertices[(i + 1) % n];
    if (a === undefined || b === undefined) continue;
    for (let j = i + 2; j < n; j += 1) {
      if (i === 0 && j === n - 1) continue; // contiguos por el cierre
      const c = vertices[j];
      const d = vertices[(j + 1) % n];
      if (c === undefined || d === undefined) continue;
      if (segmentsIntersect(a, b, c, d)) return true;
    }
  }
  return false;
}

/** Entra al modo dibujo (solo desde `idle`). */
export const start = (state: DrawingState): DrawingState => (state.phase === "idle" ? { phase: "drawing", vertices: [], issue: null } : state);

/**
 * Agrega un vértice. Ignora el clic repetido en el último punto (el doble clic dispara dos clics). Rechaza, dejando el aviso en `issue`,
 * superar el máximo, repetir un vértice anterior o un segmento que cruce la poligonal.
 */
export function addVertex(state: DrawingState, vertex: Position): DrawingState {
  if (state.phase !== "drawing") return state;
  const { vertices } = state;
  const last = vertices[vertices.length - 1];
  if (last !== undefined && same(last, vertex)) return state;
  if (!isInsideColombia(vertex)) return { ...state, issue: "outside_colombia" };
  if (vertices.length >= ZONE_MAX_VERTICES) return { ...state, issue: "max_vertices" };
  if (vertices.some((existing) => same(existing, vertex))) return { ...state, issue: "self_intersection" };
  if (last !== undefined && crossesPath(vertices, last, vertex, false)) return { ...state, issue: "self_intersection" };
  return { phase: "drawing", vertices: [...vertices, vertex], issue: null };
}

/** Quita el último vértice. Desde `closed` reabre el anillo (y quita el último punto). */
export function undo(state: DrawingState): DrawingState {
  if (state.phase === "drawing") return state.vertices.length === 0 ? state : { phase: "drawing", vertices: state.vertices.slice(0, -1), issue: null };
  if (state.phase === "closed") return { phase: "drawing", vertices: state.vertices.slice(0, -1), issue: null };
  return state;
}

/** Vuelve a `idle` SIEMPRE, también guardando (cierre de sesión o desmontaje: no puede quedar un dibujo trabado). */
export const reset = (): DrawingState => IDLE;

/** Sale del modo dibujo y descarta lo dibujado. No interrumpe un guardado en curso. */
export const cancel = (state: DrawingState): DrawingState => (state.phase === "saving" ? state : IDLE);

/** Se puede cerrar el anillo: hay al menos 3 vértices distintos. */
export const canClose = (state: DrawingState): boolean => state.phase === "drawing" && distinctCount(state.vertices) >= MIN_DISTINCT_VERTICES;

/** Cierra el anillo (lista para enviar). Con menos de 3 vértices distintos o si el cierre cruza la poligonal, no cierra y deja el aviso. */
export function close(state: DrawingState): DrawingState {
  if (state.phase !== "drawing") return state;
  const { vertices } = state;
  const first = vertices[0];
  const last = vertices[vertices.length - 1];
  if (first === undefined || last === undefined || distinctCount(vertices) < MIN_DISTINCT_VERTICES) return { ...state, issue: "too_few_vertices" };
  // Todos en línea recta: no encierran nada (y "se pliegan" sobre sí mismos, pero lo útil de decir es que no hay área).
  const second = vertices.find((vertex) => !same(vertex, first));
  if (second === undefined || vertices.every((vertex) => orientation(first, second, vertex) === 0)) return { ...state, issue: "zero_area" };
  if (crossesPath(vertices, last, first, true) || hasSelfIntersection(vertices)) return { ...state, issue: "self_intersection" };
  // Un polígono casi plano (área ínfima) tampoco sirve. Un "moño" puede sumar área cero, pero ya se rechazó arriba por cruzarse.
  if (Math.abs(signedArea(vertices)) < MIN_AREA) return { ...state, issue: "zero_area" };
  return { phase: "closed", vertices, ring: [...vertices, first] };
}

/** Empieza a guardar (solo con el anillo cerrado). */
export const beginSave = (state: DrawingState): DrawingState => (state.phase === "closed" ? { phase: "saving", vertices: state.vertices, ring: state.ring } : state);

/** El guardado falló: vuelve a `closed` con el mismo anillo, para corregir el nombre o deshacer puntos. */
export const saveFailed = (state: DrawingState): DrawingState => (state.phase === "saving" ? { phase: "closed", vertices: state.vertices, ring: state.ring } : state);

/** El guardado terminó: fin del dibujo. */
export const saved = (state: DrawingState): DrawingState => (state.phase === "saving" ? IDLE : state);

/** Vértices para pintar en cualquier fase. */
export const verticesOf = (state: DrawingState): readonly Position[] => (state.phase === "idle" ? [] : state.vertices);

/** El anillo cerrado, en `[lng, lat]`, listo para el `Polygon`; `null` si aún no se cerró. */
export const ringOf = (state: DrawingState): [number, number][] | null =>
  state.phase === "closed" || state.phase === "saving" ? state.ring.map((position): [number, number] => [position[0], position[1]]) : null;
