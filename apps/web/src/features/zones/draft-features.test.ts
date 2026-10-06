import { describe, expect, it } from "vitest";
import { buildDraftFeatures } from "./draft-features";
import { addVertex, close, IDLE, start, type DrawingState, type Position } from "./zone-drawing";

const draw = (...points: Position[]): DrawingState => points.reduce(addVertex, start(IDLE));
const parts = (state: DrawingState, pointer: Position | null = null) => buildDraftFeatures(state, pointer).features.map((feature) => feature.properties.part);

describe("buildDraftFeatures", () => {
  it("sin vértices no hay nada que pintar", () => {
    expect(buildDraftFeatures(IDLE, null).features).toEqual([]);
    expect(buildDraftFeatures(start(IDLE), [-73, 5]).features).toEqual([]);
  });

  it("un vértice: solo el punto, y con el cursor aparece la línea", () => {
    expect(parts(draw([-74, 4]))).toEqual(["vertex"]);
    expect(parts(draw([-74, 4]), [-73, 5])).toEqual(["line", "vertex"]);
  });

  it("dos vértices con cursor forman relleno de vista previa y línea", () => {
    expect(parts(draw([-74, 4], [-73, 4]), [-73, 5])).toEqual(["fill", "line", "vertex", "vertex"]);
  });

  it("marca el primer vértice y conserva el orden [lng, lat]", () => {
    const { features } = buildDraftFeatures(draw([-74.1, 4.6], [-74.0, 4.6]), null);
    const points = features.filter((feature) => feature.geometry.type === "Point");
    expect(points.map((feature) => feature.properties)).toEqual([
      { part: "vertex", first: true },
      { part: "vertex", first: false },
    ]);
    expect(points[0]?.geometry.coordinates).toEqual([-74.1, 4.6]);
  });

  it("cerrado: el polígono usa el anillo completo y la línea lo cierra, sin banda elástica", () => {
    const closed = close(draw([-74, 4], [-73, 4], [-73, 5]));
    const { features } = buildDraftFeatures(closed, [-69, 9]);
    const ring = [
      [-74, 4],
      [-73, 4],
      [-73, 5],
      [-74, 4],
    ];
    expect(features.find((feature) => feature.geometry.type === "Polygon")?.geometry.coordinates).toEqual([ring]);
    expect(features.find((feature) => feature.geometry.type === "LineString")?.geometry.coordinates).toEqual(ring);
  });

  it("dibujando, el polígono de vista previa se cierra con el primer punto", () => {
    const polygon = buildDraftFeatures(draw([-74, 4], [-73, 4]), [-73, 5]).features.find((feature) => feature.geometry.type === "Polygon");
    expect(polygon?.geometry.coordinates).toEqual([
      [
        [-74, 4],
        [-73, 4],
        [-73, 5],
        [-74, 4],
      ],
    ]);
  });
});
