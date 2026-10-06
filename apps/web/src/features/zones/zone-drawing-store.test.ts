import { describe, expect, it, vi } from "vitest";
import { createZoneDrawingStore, isDrawing } from "./zone-drawing-store";

describe("zoneDrawingStore", () => {
  it("recorre idle -> drawing -> closed -> saving -> idle", () => {
    const store = createZoneDrawingStore();
    expect(isDrawing(store.getState())).toBe(false);
    store.getState().start();
    for (const vertex of [
      [-74, 4],
      [-73, 4],
      [-73, 5],
    ] as const)
      store.getState().addVertex(vertex);
    expect(isDrawing(store.getState())).toBe(true);
    store.getState().close();
    store.getState().beginSave();
    expect(store.getState().drawing.phase).toBe("saving");
    store.getState().saveFailed();
    expect(store.getState().drawing.phase).toBe("closed");
    store.getState().beginSave();
    store.getState().saved();
    expect(store.getState().drawing.phase).toBe("idle");
  });

  it("una acción sin efecto no notifica a los suscriptores", () => {
    const store = createZoneDrawingStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.getState().cancel();
    store.getState().undo();
    store.getState().addVertex([-74, 4]);
    expect(listener).not.toHaveBeenCalled();
  });

  it("deshacer y cancelar actúan sobre el dibujo", () => {
    const store = createZoneDrawingStore();
    store.getState().start();
    store.getState().addVertex([-74, 4]);
    store.getState().addVertex([-73, 4]);
    store.getState().undo();
    expect(store.getState().drawing).toMatchObject({ vertices: [[-74, 4]] });
    store.getState().cancel();
    expect(store.getState().drawing.phase).toBe("idle");
  });

  it("reset vuelve a idle incluso guardando (cancel no)", () => {
    const store = createZoneDrawingStore();
    store.getState().start();
    for (const vertex of [
      [-74, 4],
      [-73, 4],
      [-73, 5],
    ] as const)
      store.getState().addVertex(vertex);
    store.getState().close();
    store.getState().beginSave();
    store.getState().cancel();
    expect(store.getState().drawing.phase).toBe("saving");
    store.getState().reset();
    expect(store.getState().drawing.phase).toBe("idle");
  });

  it("agrega un vértice en el centro del mapa registrado; sin mapa no hace nada", () => {
    const store = createZoneDrawingStore();
    store.getState().start();
    store.getState().addVertexAtCenter();
    expect(store.getState().drawing).toMatchObject({ vertices: [] });
    store.getState().setMapControl({ center: () => [-74.1, 4.65] });
    store.getState().addVertexAtCenter();
    expect(store.getState().drawing).toMatchObject({ vertices: [[-74.1, 4.65]] });
    // Reintentar en el mismo centro no duplica el punto.
    store.getState().addVertexAtCenter();
    expect(store.getState().drawing).toMatchObject({ vertices: [[-74.1, 4.65]] });
    store.getState().reset();
    expect(store.getState().mapControl).not.toBeNull();
  });
});
