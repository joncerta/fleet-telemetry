import type { Map as MapLibreMap } from "maplibre-gl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createZoneDrawingStore } from "../zones/zone-drawing-store";
import { attachZoneDrawing, DRAFT_LAYER_IDS, DRAFT_SOURCE_ID, unlessDrawing } from "./zone-drawing-layer";

type Handler = (event: unknown) => void;

/** Mapa falso: solo lo que usa `attachZoneDrawing`. `project` es la identidad (las coordenadas hacen de píxeles). */
function fakeMap() {
  const handlers = new Map<string, Set<Handler>>();
  const layers = new Set<string>();
  const sources = new Map<string, { setData: ReturnType<typeof vi.fn> }>();
  const canvas = { style: { cursor: "" } };
  const doubleClickZoom = { enabled: true, enable: vi.fn(() => (doubleClickZoom.enabled = true)), disable: vi.fn(() => (doubleClickZoom.enabled = false)) };
  const map = {
    addSource: (id: string) => sources.set(id, { setData: vi.fn() }),
    addLayer: ({ id }: { id: string }) => layers.add(id),
    getSource: (id: string) => sources.get(id),
    getLayer: (id: string) => (layers.has(id) ? { id } : undefined),
    removeLayer: (id: string) => layers.delete(id),
    removeSource: (id: string) => sources.delete(id),
    on: (type: string, handler: Handler) => {
      const set = handlers.get(type) ?? new Set<Handler>();
      set.add(handler);
      handlers.set(type, set);
      return { unsubscribe: () => set.delete(handler) };
    },
    getCanvas: () => canvas,
    getCenter: () => ({ lng: -74.1, lat: 4.65 }),
    project: ([x, y]: [number, number]) => ({ x, y }),
    doubleClickZoom,
  };
  const emit = (type: string, event: unknown) => {
    for (const handler of [...(handlers.get(type) ?? [])]) handler(event);
  };
  return { map: map as unknown as MapLibreMap, emit, handlers, layers, sources, canvas, doubleClickZoom };
}

/** `window`, `requestAnimationFrame` y `HTMLElement` mínimos: los tests corren en node. */
function stubBrowser() {
  const keydown = new Set<(event: unknown) => void>();
  let frames: (() => void)[] = [];
  vi.stubGlobal("window", {
    addEventListener: (type: string, handler: (event: unknown) => void) => type === "keydown" && keydown.add(handler),
    removeEventListener: (type: string, handler: (event: unknown) => void) => type === "keydown" && keydown.delete(handler),
  });
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => frames.push(callback));
  vi.stubGlobal("cancelAnimationFrame", () => (frames = []));
  class FakeElement {
    constructor(
      readonly tagName: string,
      readonly isContentEditable = false,
      private readonly inPanel = false,
    ) {}
    closest(): unknown {
      return this.inPanel ? {} : null;
    }
  }
  vi.stubGlobal("HTMLElement", FakeElement);
  return {
    keydown,
    pressEscape: (init: { defaultPrevented?: boolean; target?: unknown } = {}) => {
      for (const handler of [...keydown]) handler({ key: "Escape", defaultPrevented: false, target: null, ...init });
    },
    pendingFrames: () => frames.length,
    flushFrames: () => {
      const run = frames;
      frames = [];
      for (const frame of run) frame();
    },
    FakeElement,
  };
}

const mouse = (lng: number, lat: number, point = { x: lng, y: lat }) => ({ lngLat: { lng, lat }, point, preventDefault: vi.fn() });

function setup() {
  const browser = stubBrowser();
  const fake = fakeMap();
  const store = createZoneDrawingStore();
  const detach = attachZoneDrawing(fake.map, store);
  const source = () => fake.sources.get(DRAFT_SOURCE_ID);
  return { browser, fake, store, detach, source, phase: () => store.getState().drawing.phase };
}

afterEach(() => vi.unstubAllGlobals());

describe("attachZoneDrawing", () => {
  it("agrega la fuente y las 3 capas de la vista previa, y registra el control del mapa", () => {
    const { fake, store } = setup();
    expect(fake.sources.has(DRAFT_SOURCE_ID)).toBe(true);
    expect([...fake.layers].sort()).toEqual(Object.values(DRAFT_LAYER_IDS).sort());
    expect(store.getState().mapControl?.center()).toEqual([-74.1, 4.65]);
  });

  it("pinta ya un dibujo en curso al montar (schedule tras applyMode)", () => {
    const browser = stubBrowser();
    const fake = fakeMap();
    const store = createZoneDrawingStore();
    store.getState().start();
    store.getState().addVertex([-74, 4]);
    attachZoneDrawing(fake.map, store);
    expect(browser.pendingFrames()).toBe(1);
    browser.flushFrames();
    const data = fake.sources.get(DRAFT_SOURCE_ID)?.setData.mock.calls[0]?.[0] as { features: unknown[] };
    expect(data.features).toHaveLength(1);
  });

  it("muchos mousemove producen un solo setData por fotograma", () => {
    const { browser, fake, store, source } = setup();
    store.getState().start();
    store.getState().addVertex([-74, 4]);
    browser.flushFrames();
    const before = source()?.setData.mock.calls.length ?? 0;
    for (let i = 0; i < 200; i += 1) fake.emit("mousemove", mouse(-73.9 + i * 0.0001, 4.1));
    expect(browser.pendingFrames()).toBe(1);
    expect(source()?.setData.mock.calls.length).toBe(before);
    browser.flushFrames();
    expect(source()?.setData.mock.calls.length).toBe(before + 1);
  });

  it("el mousemove sin vértices o fuera del modo dibujo no programa nada", () => {
    const { browser, fake, store } = setup();
    fake.emit("mousemove", mouse(-74, 4));
    store.getState().start();
    browser.flushFrames();
    fake.emit("mousemove", mouse(-74, 4));
    expect(browser.pendingFrames()).toBe(0);
  });

  it("el clic agrega un vértice [lng, lat] solo dibujando", () => {
    const { fake, store } = setup();
    fake.emit("click", mouse(-74, 4));
    expect(store.getState().drawing.phase).toBe("idle");
    store.getState().start();
    fake.emit("click", mouse(-74, 4));
    expect(store.getState().drawing).toMatchObject({ vertices: [[-74, 4]] });
  });

  it("el doble clic cierra el polígono sin acercar el mapa (preventDefault); con menos de 3 puntos no cierra", () => {
    const { fake, store, phase } = setup();
    store.getState().start();
    fake.emit("click", mouse(-74, 4));
    const early = mouse(-74, 4);
    fake.emit("dblclick", early);
    expect(phase()).toBe("drawing");
    fake.emit("click", mouse(-73, 4));
    fake.emit("click", mouse(-73, 5));
    const event = mouse(-73, 5);
    fake.emit("dblclick", event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(phase()).toBe("closed");
  });

  it("un clic a 10 px o menos del primer vértice cierra; a más, agrega un punto", () => {
    const { fake, store, phase } = setup();
    store.getState().start();
    for (const [lng, lat] of [
      [-74, 4],
      [-73, 4],
      [-73, 5],
    ] as const)
      fake.emit("click", mouse(lng, lat));
    // El primer vértice proyecta a (-74, 4): 11 px más allá agrega un punto nuevo.
    fake.emit("click", mouse(-74.5, 4.5, { x: -74 + 11, y: 4 }));
    expect(phase()).toBe("drawing");
    expect(store.getState().drawing).toMatchObject({ vertices: expect.arrayContaining([[-74.5, 4.5]]) as unknown });
    fake.emit("click", mouse(-74.4, 4.4, { x: -74 + 6, y: 4 + 8 }));
    expect(phase()).toBe("closed");
  });

  it("Esc cancela solo en la fase de dibujo (no con el formulario abierto)", () => {
    const { browser, store, phase } = setup();
    browser.pressEscape();
    expect(phase()).toBe("idle");
    store.getState().start();
    for (const vertex of [
      [-74, 4],
      [-73, 4],
      [-73, 5],
    ] as const)
      store.getState().addVertex(vertex);
    store.getState().close();
    browser.pressEscape();
    expect(phase()).toBe("closed");
    store.getState().undo();
    expect(phase()).toBe("drawing");
    browser.pressEscape();
    expect(phase()).toBe("idle");
  });

  it("Esc que otro componente ya atendió, o escrito en un campo fuera del panel, no cancela; dentro del panel sí", () => {
    const { browser, store, phase } = setup();
    store.getState().start();
    browser.pressEscape({ defaultPrevented: true });
    expect(phase()).toBe("drawing");
    browser.pressEscape({ target: new browser.FakeElement("INPUT") });
    expect(phase()).toBe("drawing");
    browser.pressEscape({ target: new browser.FakeElement("DIV", true) });
    expect(phase()).toBe("drawing");
    browser.pressEscape({ target: new browser.FakeElement("INPUT", false, true) });
    expect(phase()).toBe("idle");
  });

  it("al dibujar: cursor en cruz y sin zoom por doble clic; al salir, se restauran", () => {
    const { fake, store } = setup();
    expect(fake.canvas.style.cursor).toBe("");
    store.getState().start();
    expect(fake.canvas.style.cursor).toBe("crosshair");
    expect(fake.doubleClickZoom.enabled).toBe(false);
    store.getState().cancel();
    expect(fake.canvas.style.cursor).toBe("");
    expect(fake.doubleClickZoom.enabled).toBe(true);
  });

  it("detach quita los 4 listeners, las 3 capas, la fuente y el keydown, y restaura el mapa", () => {
    const { browser, fake, store, detach, phase } = setup();
    store.getState().start();
    expect(browser.keydown.size).toBe(1);
    expect([...fake.handlers.values()].map((set) => set.size)).toEqual([1, 1, 1, 1]);
    detach();
    expect([...fake.handlers.values()].map((set) => set.size)).toEqual([0, 0, 0, 0]);
    expect(fake.layers.size).toBe(0);
    expect(fake.sources.size).toBe(0);
    expect(browser.keydown.size).toBe(0);
    expect(store.getState().mapControl).toBeNull();
    expect(fake.canvas.style.cursor).toBe("");
    expect(fake.doubleClickZoom.enabled).toBe(true);
    // Ya sin listeners: Esc y el store no tocan el mapa ni lanzan.
    browser.pressEscape();
    expect(phase()).toBe("drawing");
    expect(() => store.getState().addVertex([-74, 4])).not.toThrow();
    expect(browser.pendingFrames()).toBe(0);
  });
});

describe("unlessDrawing", () => {
  it("ignora el handler mientras se dibuja y lo ejecuta en reposo", () => {
    const store = createZoneDrawingStore();
    const handler = vi.fn();
    const guarded = unlessDrawing(store, handler);
    guarded("a");
    expect(handler).toHaveBeenCalledWith("a");
    store.getState().start();
    guarded("b");
    expect(handler).toHaveBeenCalledTimes(1);
    store.getState().reset();
    guarded("c");
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
