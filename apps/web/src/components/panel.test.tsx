import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildAlertFeed } from "../features/alerts/alert-feed";
import { AlertList } from "../features/alerts/AlertsPanel";
import { alert, VEHICLE_A, VEHICLE_B } from "../test-support/fixtures";
import { CollapsiblePanelView } from "./panel";

const noop = () => undefined;
const render = (open: boolean, extra: { keepMounted?: boolean } = {}) =>
  renderToStaticMarkup(
    <CollapsiblePanelView id="alerts" title="Alertas en vivo" count="6 activas" open={open} onToggle={noop} persistent={<div aria-live="polite" />} {...extra}>
      <p>contenido</p>
    </CollapsiblePanelView>,
  );

describe("CollapsiblePanelView", () => {
  it("cerrado: el contador sigue visible, aria-expanded=false, el cuerpo oculto y sin montar", () => {
    const html = render(false);
    expect(html).toContain("· 6 activas");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="alerts-body"');
    expect(html).toContain('id="alerts-body" hidden=""');
    expect(html).not.toContain("contenido");
  });

  it("abierto: aria-expanded=true y muestra el contenido", () => {
    const html = render(true);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("contenido");
    expect(html).not.toContain('hidden=""');
  });

  it("keepMounted conserva el contenido en el DOM aun cerrado", () => {
    expect(render(false, { keepMounted: true })).toContain("contenido");
  });

  it("la región aria-live persiste con el panel cerrado", () => {
    expect(render(false)).toContain('aria-live="polite"');
  });

  it("sin contador no deja un separador suelto; el contador 0 sí se muestra", () => {
    const base = { id: "x", title: "Detenidos", open: false, onToggle: noop };
    expect(renderToStaticMarkup(<CollapsiblePanelView {...base}>.</CollapsiblePanelView>)).not.toContain("·");
    expect(renderToStaticMarkup(<CollapsiblePanelView {...base} count={0}>.</CollapsiblePanelView>)).toContain("· 0");
  });
});

describe("AlertList: activas primero e historial plegado", () => {
  it("las resueltas van en 'Historial (N)' cerrado: no se renderizan sus filas", () => {
    const groups = buildAlertFeed([
      alert({ vehicleId: VEHICLE_A, plate: "NRT101" }),
      alert({ vehicleId: VEHICLE_B, plate: "NRT102", resolvedAt: "2026-10-06T15:05:00.000Z" }),
    ]);
    const html = renderToStaticMarkup(<AlertList groups={groups} onSelect={noop} />);
    expect(html).toContain("NRT101");
    expect(html).toContain("Historial (1)");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("NRT102");
  });

  it("sin activas lo dice, y sin resueltas no hay historial", () => {
    const onlyResolved = buildAlertFeed([alert({ resolvedAt: "2026-10-06T15:05:00.000Z" })]);
    expect(renderToStaticMarkup(<AlertList groups={onlyResolved} onSelect={noop} />)).toContain("Sin alertas activas.");
    const onlyActive = buildAlertFeed([alert()]);
    expect(renderToStaticMarkup(<AlertList groups={onlyActive} onSelect={noop} />)).not.toContain("Historial");
  });
});
