import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CollapsiblePanelView } from "../../components/panel";
import { panelError } from "../../components/panel-error";
import { formatTime } from "../../lib/format";
import { failed, idle, loading, ready } from "../../lib/loadable";
import { NOW_MS, stoppedResponse, summary } from "../../test-support/fixtures";
import { StoppedBody } from "../stopped/StoppedPanel";
import { KpiGrid } from "./KpiPanel";

const noop = () => undefined;
const alertCount = (html: string) => html.split('role="alert"').length - 1;

/** El panel tal como lo arman KpiPanel y StoppedPanel: el aviso sale de `panelError`, en el encabezado y no en el cuerpo. */
const panel = (resource: Parameters<typeof panelError>[0], open: boolean) =>
  renderToStaticMarkup(
    <CollapsiblePanelView id="kpi" title="Resumen de la flota" count="15 vehículos" error={panelError(resource, "Datos")} open={open} onToggle={noop}>
      <KpiGrid summary={ready(summary(), NOW_MS)} />
    </CollapsiblePanelView>,
  );

describe("aviso de error con la API caída", () => {
  it("panelError: sin error no hay aviso", () => {
    expect(panelError(ready(summary(), NOW_MS), "Datos")).toBeNull();
    expect(panelError(idle(), "Datos")).toBeNull();
  });

  it("panelError: con datos viejos dice de cuándo son; sin datos, solo el error", () => {
    const stale = failed(ready(summary(), NOW_MS), "No se pudo conectar con el servidor.");
    expect(panelError(stale, "Datos")).toEqual({
      summary: `Error · datos de las ${formatTime(NOW_MS)}`,
      message: `No se pudo conectar con el servidor. Datos de las ${formatTime(NOW_MS)}.`,
    });
    expect(panelError(failed(idle(), "No se pudieron cargar los datos."), "Datos")).toEqual({ summary: "Error", message: "No se pudieron cargar los datos." });
  });

  it("panelError: loading() conserva el error, así que el aviso no cambia mientras recarga", () => {
    const afterFailure = failed(ready(summary(), NOW_MS), "No se pudo conectar con el servidor.");
    expect(panelError(loading(afterFailure), "Datos")).toEqual(panelError(afterFailure, "Datos"));
  });

  it("con el panel CERRADO el encabezado muestra el error (en vez del contador viejo) y hay un único role=alert", () => {
    const html = panel(failed(ready(summary(), NOW_MS), "No se pudo conectar con el servidor."), false);
    expect(html).toContain("· Error · datos de las");
    expect(html).not.toContain("15 vehículos");
    expect(html).toContain("No se pudo conectar con el servidor.");
    expect(alertCount(html)).toBe(1);
  });

  it("con el panel abierto sigue habiendo un único role=alert (el cuerpo no repite el aviso)", () => {
    expect(alertCount(panel(failed(ready(summary(), NOW_MS), "Falló."), true))).toBe(1);
  });

  it("sin error: contador visible y ningún role=alert", () => {
    const html = panel(ready(summary(), NOW_MS), false);
    expect(html).toContain("· 15 vehículos");
    expect(alertCount(html)).toBe(0);
  });

  it("Detenidos: el cuerpo ya no trae role=alert y 'Cargando…' no sale si hubo error", () => {
    const html = renderToStaticMarkup(
      <StoppedBody stopped={loading(failed(ready(stoppedResponse(), NOW_MS), "No se pudo conectar."))} rows={[]} onSelect={noop} />,
    );
    expect(alertCount(html)).toBe(0);
    const firstLoadFailed = renderToStaticMarkup(<StoppedBody stopped={failed(idle(), "No se pudieron cargar los datos.")} rows={[]} onSelect={noop} />);
    expect(firstLoadFailed).not.toContain("Cargando…");
  });

  it("Detenidos: sin error y sin datos, muestra 'Cargando…'", () => {
    const html = renderToStaticMarkup(<StoppedBody stopped={{ data: null, error: null, updatedAt: null }} rows={[]} onSelect={noop} />);
    expect(html).toContain("Cargando…");
    expect(alertCount(html)).toBe(0);
  });
});
