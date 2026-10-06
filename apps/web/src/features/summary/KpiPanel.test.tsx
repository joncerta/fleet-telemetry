import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { failed, loading, ready } from "../../lib/loadable";
import { NOW_MS, stoppedResponse, summary } from "../../test-support/fixtures";
import { StoppedBody } from "../stopped/StoppedPanel";
import { KpiGrid } from "./KpiPanel";

const noop = () => undefined;

describe("aviso de error con la API caída", () => {
  it("KPIs: el role=alert sigue montado mientras recarga (loading conserva el error), no solo en el estado 'error'", () => {
    const afterFailure = failed(ready(summary(), NOW_MS), "No se pudo conectar con el servidor.");
    const reloading = loading(afterFailure);
    expect(reloading.status).toBe("loading");
    const html = renderToStaticMarkup(<KpiGrid summary={reloading} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("No se pudo conectar con el servidor.");
  });

  it("KPIs: tras una respuesta válida el aviso desaparece", () => {
    expect(renderToStaticMarkup(<KpiGrid summary={ready(summary(), NOW_MS)} />)).not.toContain('role="alert"');
  });

  it("Detenidos: el role=alert sigue montado mientras recarga y 'Cargando…' no tapa el error", () => {
    const base = ready(stoppedResponse(), NOW_MS);
    const reloading = loading(failed(base, "No se pudo conectar con el servidor."));
    const html = renderToStaticMarkup(<StoppedBody stopped={reloading} rows={[]} onSelect={noop} />);
    expect(html).toContain('role="alert"');

    const firstLoadFailed = loading(failed({ status: "idle", data: null, updatedAt: null, error: null }, "No se pudieron cargar los datos."));
    const html2 = renderToStaticMarkup(<StoppedBody stopped={firstLoadFailed} rows={[]} onSelect={noop} />);
    expect(html2).toContain('role="alert"');
    expect(html2).not.toContain("Cargando…");
  });

  it("Detenidos: sin error y sin datos, muestra 'Cargando…'", () => {
    const html = renderToStaticMarkup(<StoppedBody stopped={{ data: null, error: null, updatedAt: null }} rows={[]} onSelect={noop} />);
    expect(html).toContain("Cargando…");
    expect(html).not.toContain('role="alert"');
  });
});
