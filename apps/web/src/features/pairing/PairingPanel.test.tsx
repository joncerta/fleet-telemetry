import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { catalogItem } from "../../test-support/catalog-fixtures";
import { idle, ready } from "../../lib/loadable";
import { formatInteger } from "../../lib/format";
import { CATALOG_LIMIT, type PairingState } from "./pairing-controller";
import { nextFormState } from "./pairing-form";
import { catalogOptionLabel, NewVehicleFields, PairingView, pairingCount } from "./PairingPanel";

const noop = () => undefined;
const baseState: PairingState = { catalog: idle(), submit: "idle", error: null, plateError: null, labelError: null, result: null, suggestedVehicleId: null };
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

describe("nextFormState", () => {
  const code = { code: { code: "ABCD2345", vehicleId: "v1", expiresAt: "2099-01-01T00:00:00.000Z" }, plate: "ABC123" };
  const none = { suggestedVehicleId: null, result: null };

  it("una sugerencia nueva (vehículo creado sin código, o existente tras un 409) elige ese vehículo", () => {
    expect(nextFormState(none, { suggestedVehicleId: "v1", result: null }, true)).toEqual({ selection: "v1", clearForm: false });
  });

  it("la misma sugerencia no vuelve a elegir; sin sugerencia no cambia nada", () => {
    expect(nextFormState({ suggestedVehicleId: "v1", result: null }, { suggestedVehicleId: "v1", result: null }, false).selection).toBeNull();
    expect(nextFormState({ suggestedVehicleId: "v1", result: null }, none, false).selection).toBeNull();
    // El controlador borra la sugerencia al empezar cada envío: repetirla después sí vuelve a elegir.
    expect(nextFormState(none, { suggestedVehicleId: "v1", result: null }, false).selection).toBe("v1");
  });

  it("un alta con código limpia el formulario; un código de un vehículo ya elegido, no", () => {
    expect(nextFormState(none, { suggestedVehicleId: null, result: code }, true)).toEqual({ selection: null, clearForm: true });
    expect(nextFormState(none, { suggestedVehicleId: null, result: code }, false).clearForm).toBe(false);
    expect(nextFormState({ suggestedVehicleId: null, result: code }, { suggestedVehicleId: null, result: code }, true).clearForm).toBe(false);
  });
});

/** La etiqueta `<input>` de un campo (React no garantiza el orden de los atributos). */
const inputTag = (html: string, name: string): string => new RegExp(`<input[^>]*name="${name}"[^>]*>`).exec(html)?.[0] ?? "";

describe("NewVehicleFields", () => {
  const fields = (props: Partial<Parameters<typeof NewVehicleFields>[0]>) =>
    renderToStaticMarkup(<NewVehicleFields plate="" label="" onPlateChange={noop} onLabelChange={noop} plateError={null} labelError={null} readOnly={false} {...props} />);

  it("el error de la placa se enlaza al campo: aria-invalid y aria-describedby apuntan al id del mensaje", () => {
    const html = fields({ plateError: "Escribe la placa." });
    const plateTag = inputTag(html, "plate");
    const describedBy = /aria-describedby="([^"]+)"/.exec(plateTag)?.[1];
    expect(describedBy).toBeDefined();
    expect(plateTag).toContain('aria-invalid="true"');
    expect(html).toContain(`<p id="${String(describedBy)}" role="alert" class="text-xs text-danger">Escribe la placa.</p>`);
    expect(inputTag(html, "label")).toContain('aria-invalid="false"');
  });

  it("el error del nombre se enlaza a su campo", () => {
    const html = fields({ labelError: "El nombre admite hasta 64 caracteres, sin caracteres de control." });
    const labelTag = inputTag(html, "label");
    const describedBy = /aria-describedby="([^"]+)"/.exec(labelTag)?.[1];
    expect(describedBy).toBeDefined();
    expect(labelTag).toContain('aria-invalid="true"');
    expect(html).toContain(`<p id="${String(describedBy)}" role="alert"`);
  });

  it("sin errores no hay aria-describedby ni avisos; enviando, los campos son de solo lectura (no disabled)", () => {
    const html = fields({ readOnly: true });
    expect(html).not.toContain("aria-describedby");
    expect(html).not.toContain('role="alert"');
    expect(html.match(/readOnly=""/g)).toHaveLength(2);
    expect(html).not.toContain("disabled");
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
    // `aria-disabled` y no `disabled`: el botón enfocado no pierde el foco al enviar.
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*aria-disabled="true"[^>]*>Generar código<\/button>/);
    expect(html).not.toMatch(/<button[^>]*type="submit"[^>]* disabled=""/);
  });

  it("un catálogo que llega al tope avisa que hay más y marca el contador con +", () => {
    const items = Array.from({ length: CATALOG_LIMIT }, () => catalogItem());
    expect(render({ catalog: ready(items, 0) })).toContain(`Se muestran los primeros ${formatInteger(CATALOG_LIMIT)} vehículos.`);
    expect(pairingCount(items)).toBe(`${String(CATALOG_LIMIT)}+ sin dispositivo`);
    expect(render({ catalog: ready([catalogItem()], 0) })).not.toContain("Se muestran los primeros");
  });

  it("siempre ofrece Actualizar para volver a leer el catálogo", () => {
    expect(render({ catalog: ready([], 0) })).toContain("Actualizar");
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
