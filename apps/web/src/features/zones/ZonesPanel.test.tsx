import { ZONE_NAME_MAX_LENGTH } from "@fleet/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ZonesView, zoneRows, type ZoneRow, type ZonesViewProps } from "./ZonesPanel";
import { addVertex, beginSave, close, IDLE, start, type DrawingState, type Position } from "./zone-drawing";
import { zoneKindLabel } from "./zone-errors";

const noop = () => undefined;
const draw = (...points: Position[]): DrawingState => points.reduce(addVertex, start(IDLE));
const rows: ZoneRow[] = [
  { zoneId: "1", name: "Bodega 10", kind: "depot" },
  { zoneId: "2", name: "Bodega 2", kind: "critical" },
  { zoneId: "3", name: "Cliente <b>x</b>", kind: "customer" },
];
const render = (props: Partial<ZonesViewProps>) =>
  renderToStaticMarkup(
    <ZonesView
      rows={[]}
      loading={false}
      drawing={IDLE}
      save={{ submit: "idle", error: null, nameError: null }}
      onStart={noop}
      onUndo={noop}
      onCancel={noop}
      onClose={noop}
      onSave={noop}
      onClearFeedback={noop}
      {...props}
    />,
  );

describe("zoneRows / zoneKindLabel", () => {
  it("ordena por nombre de forma natural", () => {
    const features = [
      { properties: { zoneId: "a", name: "Zona 10", kind: "depot" as const } },
      { properties: { zoneId: "b", name: "Zona 2", kind: "depot" as const } },
    ];
    expect(zoneRows(features).map((row) => row.name)).toEqual(["Zona 2", "Zona 10"]);
    expect(zoneRows(undefined)).toEqual([]);
  });

  it("etiquetas legibles", () => {
    expect(zoneKindLabel("critical")).toBe("Crítica");
    expect(zoneKindLabel("depot")).toBe("Depósito");
    expect(zoneKindLabel("customer")).toBe("Cliente");
    expect(zoneKindLabel("unknown")).toBe("Otro");
  });
});

describe("ZonesView", () => {
  it("lista las zonas con su tipo legible y escapa el nombre", () => {
    const html = render({ rows });
    expect(html).toContain("Bodega 10");
    expect(html).toContain("Depósito");
    expect(html).toContain("Crítica");
    expect(html).toContain("Cliente &lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain('aria-label="Zonas"');
  });

  it("estados: cargando, vacío y botón para crear", () => {
    expect(render({ loading: true })).toContain("Cargando zonas…");
    const empty = render({});
    expect(empty).toContain("Esta flota aún no tiene zonas.");
    expect(empty).toContain("Nueva zona");
  });

  it("dibujando: instrucciones, contador y botones; sin el botón Nueva zona", () => {
    const html = render({ drawing: draw([-74, 4], [-73, 4]) });
    expect(html).toContain("Haz clic en el mapa para agregar vértices");
    expect(html).toContain("2 puntos");
    expect(html).toContain("Deshacer punto");
    expect(html).toContain("Cerrar polígono");
    expect(html).toContain("Cancelar");
    expect(html).not.toContain(">Nueva zona<");
    // Con menos de 3 puntos no se puede cerrar.
    expect(html).toMatch(/aria-disabled="true"[^>]*>Cerrar polígono/);
  });

  it("con 3 puntos se puede cerrar", () => {
    expect(render({ drawing: draw([-74, 4], [-73, 4], [-73, 5]) })).toMatch(/aria-disabled="false"[^>]*>Cerrar polígono/);
  });

  it("avisa cuando un punto se rechaza", () => {
    const rejected = addVertex(draw([-74, 4], [-72, 6], [-72, 4]), [-74, 6]);
    expect(render({ drawing: rejected })).toContain("se cruce consigo mismo");
  });

  it("anillo cerrado: formulario con nombre, tipo y Guardar", () => {
    const html = render({ drawing: close(draw([-74, 4], [-73, 4], [-73, 5])) });
    expect(html).toContain("Nombre");
    expect(html).toContain("Tipo");
    for (const label of ["Crítica", "Depósito", "Cliente"]) expect(html).toContain(label);
    expect(html).toContain(">Guardar<");
    expect(html).toContain(`maxLength="${String(ZONE_NAME_MAX_LENGTH * 2)}"`);
    expect(html).toContain('aria-invalid="false"');
  });

  it("error del nombre: asociado al campo con aria-invalid y aria-describedby", () => {
    const html = render({ drawing: close(draw([-74, 4], [-73, 4], [-73, 5])), save: { submit: "failed", error: null, nameError: "Ya existe una zona con ese nombre." } });
    expect(html).toContain('aria-invalid="true"');
    const describedBy = /aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(describedBy).toBeDefined();
    expect(html).toContain(`id="${describedBy ?? ""}"`);
    expect(html).toContain("Ya existe una zona con ese nombre.");
  });

  it("aviso general del servidor como alerta", () => {
    const html = render({ drawing: close(draw([-74, 4], [-73, 4], [-73, 5])), save: { submit: "failed", error: "No se pudo guardar la zona.", nameError: null } });
    expect(html).toMatch(/role="alert"[^>]*>No se pudo guardar la zona\./);
  });

  it("guardando: botón bloqueado y campos de solo lectura", () => {
    const html = render({ drawing: beginSave(close(draw([-74, 4], [-73, 4], [-73, 5]))), save: { submit: "submitting", error: null, nameError: null } });
    expect(html).toContain("Guardando…");
    expect(html).toContain('readOnly=""');
    expect(html).toContain("disabled");
  });
});
