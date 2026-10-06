import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { catalogItem } from "../../test-support/catalog-fixtures";
import { idle, ready } from "../../lib/loadable";
import type { PairingState } from "./pairing-controller";
import { catalogOptionLabel, PairingView, pairingCount } from "./PairingPanel";

const noop = () => undefined;
const baseState: PairingState = { catalog: idle(), submit: "idle", error: null, plateError: null, labelError: null, result: null, createdVehicleId: null };
const render = (state: Partial<PairingState>) =>
  renderToStaticMarkup(
    <PairingView state={{ ...baseState, ...state }} onPair={noop} onCreate={noop} onClearFeedback={noop} onReloadCatalog={noop} serverOffsetMs={() => 0} />,
  );

describe("catalogOptionLabel", () => {
  it("muestra placa y nombre, y marca en texto el que ya tiene dispositivo", () => {
    expect(catalogOptionLabel(catalogItem({ plate: "NRT101", label: null }))).toBe("NRT101");
    expect(catalogOptionLabel(catalogItem({ plate: "NRT101", label: "Camión 3" }))).toBe("NRT101 — Camión 3");
    expect(catalogOptionLabel(catalogItem({ plate: "NRT101", label: "Camión 3", hasActiveDevice: true }))).toBe("NRT101 — Camión 3 (con dispositivo)");
  });
});

describe("pairingCount", () => {
  it("cuenta los vehículos sin dispositivo y no muestra nada mientras no hay catálogo", () => {
    expect(pairingCount(null)).toBeUndefined();
    expect(pairingCount([])).toBe("0 sin dispositivo");
    expect(pairingCount([catalogItem({ hasActiveDevice: true }), catalogItem(), catalogItem()])).toBe("2 sin dispositivo");
  });
});

describe("PairingView", () => {
  it("cargando: sin formulario hasta tener el catálogo", () => {
    const html = render({});
    expect(html).toContain("Cargando vehículos…");
    expect(html).not.toContain("<form");
  });

  it("con catálogo: el selector trae 'Nuevo vehículo' y cada vehículo con su marca de dispositivo, y no se puede generar sin elegir", () => {
    const html = render({
      catalog: ready([catalogItem({ plate: "NRT101", label: "Uno" }), catalogItem({ plate: "NRT102", hasActiveDevice: true })], 0),
    });
    expect(html).toContain("Nuevo vehículo");
    expect(html).toContain("NRT101 — Uno");
    expect(html).toContain("NRT102 (con dispositivo)");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Generar código<\/button>/);
  });

  it("un error del catálogo ofrece reintentar; el aviso va en el encabezado del panel (panelError), no en el cuerpo", () => {
    const html = render({ catalog: { status: "error", data: null, updatedAt: null, error: "No se pudieron cargar los vehículos." } });
    expect(html).not.toContain('role="alert"');
    expect(html).toContain("Reintentar");
  });

  it("muestra el código generado con su vencimiento", () => {
    const html = render({
      catalog: ready([], 0),
      submit: "done",
      result: { code: { code: "ABCD2345", vehicleId: "c47a1000-0000-4000-8000-000000000001", expiresAt: "2099-01-01T00:00:00.000Z" }, plate: "NRT101" },
    });
    expect(html).toContain("Código para NRT101");
    expect(html).toContain("ABCD2345");
    expect(html).toContain("Vence a las");
  });
});
