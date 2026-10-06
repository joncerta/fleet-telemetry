import { describe, expect, it } from "vitest";
import { COLOMBIA_BBOX, ZONE_MAX_VERTICES } from "@fleet/contracts";
import {
  addVertex,
  beginSave,
  cancel,
  canClose,
  close,
  distinctCount,
  hasSelfIntersection,
  isInsideColombia,
  IDLE,
  ringOf,
  saved,
  saveFailed,
  segmentsIntersect,
  start,
  undo,
  verticesOf,
  type DrawingState,
  type Position,
} from "./zone-drawing";

const A: Position = [-74.1, 4.6];
const B: Position = [-74.0, 4.6];
const C: Position = [-74.0, 4.7];
const D: Position = [-74.1, 4.7];

const draw = (...points: Position[]): DrawingState => points.reduce(addVertex, start(IDLE));

describe("transiciones", () => {
  it("start solo entra desde idle y no cambia otras fases", () => {
    const drawing = start(IDLE);
    expect(drawing).toEqual({ phase: "drawing", vertices: [], issue: null });
    expect(start(drawing)).toBe(drawing);
  });

  it("addVertex solo funciona dibujando", () => {
    expect(addVertex(IDLE, A)).toBe(IDLE);
    const closed = close(draw(A, B, C));
    expect(addVertex(closed, D)).toBe(closed);
  });

  it("agrega vértices en orden [lng, lat]", () => {
    expect(verticesOf(draw(A, B, C))).toEqual([A, B, C]);
  });

  it("un clic repetido en el último punto (doble clic) se ignora sin aviso", () => {
    const one = draw(A);
    expect(addVertex(one, A)).toBe(one);
  });

  it("deshacer quita el último vértice y no falla sin vértices", () => {
    expect(verticesOf(undo(draw(A, B)))).toEqual([A]);
    const empty = start(IDLE);
    expect(undo(empty)).toBe(empty);
    expect(undo(IDLE)).toBe(IDLE);
  });

  it("deshacer desde cerrado reabre el anillo sin el último punto", () => {
    const reopened = undo(close(draw(A, B, C, D)));
    expect(reopened).toEqual({ phase: "drawing", vertices: [A, B, C], issue: null });
  });

  it("cancelar descarta el dibujo, salvo mientras se guarda", () => {
    expect(cancel(draw(A, B))).toBe(IDLE);
    expect(cancel(close(draw(A, B, C)))).toBe(IDLE);
    const saving = beginSave(close(draw(A, B, C)));
    expect(cancel(saving)).toBe(saving);
  });
});

describe("cerrar el anillo", () => {
  it("con menos de 3 vértices no cierra y avisa", () => {
    expect(close(draw(A, B))).toMatchObject({ phase: "drawing", issue: "too_few_vertices" });
    expect(canClose(draw(A, B))).toBe(false);
    expect(close(start(IDLE))).toMatchObject({ phase: "drawing", issue: "too_few_vertices" });
  });

  it("con 3 vértices distintos cierra y produce el anillo con el primero repetido al final", () => {
    const closed = close(draw(A, B, C));
    expect(closed.phase).toBe("closed");
    expect(ringOf(closed)).toEqual([A, B, C, A]);
    expect(canClose(draw(A, B, C))).toBe(true);
  });

  it("el anillo tiene al menos 4 posiciones y empieza y termina igual", () => {
    const ring = ringOf(close(draw(A, B, C, D)));
    expect(ring).toHaveLength(5);
    expect(ring?.[0]).toEqual(ring?.[ring.length - 1]);
  });

  it("close solo actúa dibujando", () => {
    expect(close(IDLE)).toBe(IDLE);
  });

  it("no hay anillo antes de cerrar", () => {
    expect(ringOf(draw(A, B, C))).toBeNull();
    expect(ringOf(IDLE)).toBeNull();
  });

  it("un cierre que cruzaría la poligonal se rechaza y deja el dibujo como estaba", () => {
    // Cada punto es válido por separado, pero el segmento de cierre (2,0)->(0,0) corta el tramo (1,1)-(1,-1).
    const open = draw([-74, 4], [-73, 5], [-73, 3], [-72, 4]);
    expect(verticesOf(open)).toHaveLength(4);
    const result = close(open);
    expect(result).toMatchObject({ phase: "drawing", issue: "self_intersection" });
    expect(verticesOf(result)).toEqual(verticesOf(open));
  });
});

describe("guardado", () => {
  it("closed -> saving -> idle al guardar", () => {
    const closed = close(draw(A, B, C));
    const saving = beginSave(closed);
    expect(saving.phase).toBe("saving");
    expect(ringOf(saving)).toEqual([A, B, C, A]);
    expect(saved(saving)).toBe(IDLE);
  });

  it("si falla vuelve a closed con el mismo anillo", () => {
    const closed = close(draw(A, B, C));
    const back = saveFailed(beginSave(closed));
    expect(back).toEqual(closed);
  });

  it("beginSave, saveFailed y saved solo actúan en su fase", () => {
    const drawing = draw(A, B, C);
    expect(beginSave(drawing)).toBe(drawing);
    expect(saveFailed(drawing)).toBe(drawing);
    expect(saved(drawing)).toBe(drawing);
  });
});

describe("validaciones locales", () => {
  it("cuenta solo los vértices distintos", () => {
    expect(distinctCount([A, B, A, B])).toBe(2);
  });

  it("rechaza repetir un vértice anterior (no consecutivo)", () => {
    expect(addVertex(draw(A, B, C), A)).toMatchObject({ phase: "drawing", issue: "self_intersection" });
  });

  it("rechaza un vértice que haga cruzar el segmento nuevo con uno anterior (moño)", () => {
    // A(0,0)->B(2,2)->C(2,0): el segmento C->D(0,2) cruza A->B.
    const state = addVertex(draw([-74, 4], [-72, 6], [-72, 4]), [-74, 6]);
    expect(state).toMatchObject({ phase: "drawing", issue: "self_intersection" });
    expect(verticesOf(state)).toHaveLength(3);
  });

  it("el rechazo no pierde los vértices y un punto válido después limpia el aviso", () => {
    const rejected = addVertex(draw([-74, 4], [-72, 6], [-72, 4]), [-74, 6]);
    const next = addVertex(rejected, [-74, 3]);
    expect(next).toMatchObject({ phase: "drawing", issue: null });
    expect(verticesOf(next)).toHaveLength(4);
  });

  it("rechaza plegarse sobre el segmento contiguo", () => {
    // A->B(2,0) y luego volver a (1,0), sobre el mismo segmento.
    expect(addVertex(draw([-74, 4], [-72, 4]), [-73, 4])).toMatchObject({ issue: "self_intersection" });
  });

  it("rechaza tocar un segmento anterior con el nuevo vértice", () => {
    // (1,0) cae sobre el segmento A(0,0)-B(2,0): el segmento C(1,-1)->(1,0) lo toca.
    expect(addVertex(draw([-74, 4], [-72, 4], [-73, 3]), [-73, 4])).toMatchObject({ issue: "self_intersection" });
  });

  it("acepta un polígono cóncavo válido", () => {
    const concave = draw([-74, 4], [-70, 4], [-70, 8], [-72, 5], [-74, 8]);
    expect(verticesOf(concave)).toHaveLength(5);
    expect(close(concave).phase).toBe("closed");
  });

  it("limita los vértices al máximo", () => {
    // Puntos sobre un círculo: convexo, sin cruces.
    const circle = (index: number): Position => [-74 + Math.cos((index / (ZONE_MAX_VERTICES + 1)) * 2 * Math.PI), 4 + Math.sin((index / (ZONE_MAX_VERTICES + 1)) * 2 * Math.PI)];
    let state = start(IDLE);
    for (let i = 0; i < ZONE_MAX_VERTICES; i += 1) state = addVertex(state, circle(i));
    expect(verticesOf(state)).toHaveLength(ZONE_MAX_VERTICES);
    expect(addVertex(state, circle(ZONE_MAX_VERTICES))).toMatchObject({ issue: "max_vertices" });
    const closed = close(state);
    expect(ringOf(closed)).toHaveLength(ZONE_MAX_VERTICES + 1);
  });
});

describe("dentro de Colombia", () => {
  it("rechaza un vértice fuera del rectángulo, con aviso y sin perder lo dibujado", () => {
    const base = draw(A, B);
    for (const outside of [[0, 0], [-74.1, 40], [-90, 4.6], [-74.1, -10]] as const) {
      expect(addVertex(base, outside)).toMatchObject({ phase: "drawing", issue: "outside_colombia" });
    }
    expect(verticesOf(addVertex(base, [0, 0]))).toEqual([A, B]);
  });

  it("los bordes del rectángulo cuentan como dentro", () => {
    expect(isInsideColombia([COLOMBIA_BBOX.minLon, COLOMBIA_BBOX.minLat])).toBe(true);
    expect(isInsideColombia([COLOMBIA_BBOX.maxLon, COLOMBIA_BBOX.maxLat])).toBe(true);
    expect(isInsideColombia([COLOMBIA_BBOX.maxLon + 0.001, 4])).toBe(false);
  });
});

describe("segmentsIntersect", () => {
  it("detecta cruces propios, toques en extremo y traslapes colineales", () => {
    expect(segmentsIntersect([-74, 4], [-72, 6], [-74, 6], [-72, 4])).toBe(true);
    expect(segmentsIntersect([-74, 4], [-73, 5], [-73, 5], [-72, 4])).toBe(true);
    expect(segmentsIntersect([-74, 4], [-72, 4], [-73, 4], [-71, 4])).toBe(true);
  });

  it("no marca segmentos separados ni colineales sin traslape", () => {
    expect(segmentsIntersect([-74, 4], [-73, 4], [-74, 5], [-73, 5])).toBe(false);
    expect(segmentsIntersect([-74, 4], [-73, 4], [-72, 4], [-71, 4])).toBe(false);
    expect(segmentsIntersect([-74, 4], [-73, 5], [-72, 4], [-71, 7])).toBe(false);
  });
});

describe("hasSelfIntersection", () => {
  it("un cuadrado no se cruza; un moño sí", () => {
    expect(hasSelfIntersection([A, B, C, D])).toBe(false);
    expect(hasSelfIntersection([[-74, 4], [-72, 6], [-72, 4], [-74, 6]])).toBe(true);
  });

  it("un triángulo nunca se cruza", () => {
    expect(hasSelfIntersection([A, B, C])).toBe(false);
  });
});
