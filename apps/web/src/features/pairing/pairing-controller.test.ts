import { PLATE_TAKEN_ERROR_CODE } from "@fleet/contracts";
import { describe, expect, it, vi } from "vitest";
import { ApiRequestError, NetworkError, UnauthorizedError } from "../../lib/api/http-client";
import type { FleetApi } from "../../lib/api/fleet-api";
import { catalogItem, pairingCode } from "../../test-support/catalog-fixtures";
import { createPairingController, sortCatalog, withoutDevice } from "./pairing-controller";
import { validateVehicleForm } from "./pairing-errors";

type Api = Pick<FleetApi, "listVehicles" | "createVehicle" | "createPairingCode">;

function setup(overrides: Partial<Api> = {}) {
  const vehicle = catalogItem({ plate: "NRT101" });
  const api = {
    listVehicles: vi.fn<Api["listVehicles"]>(() => Promise.resolve({ items: [vehicle], limit: 500 })),
    createVehicle: vi.fn<Api["createVehicle"]>((request) => Promise.resolve(catalogItem({ plate: request.plate, label: request.label }))),
    createPairingCode: vi.fn<Api["createPairingCode"]>((vehicleId) => Promise.resolve(pairingCode(vehicleId))),
  };
  // `api` conserva los mocks por defecto (para las aserciones); `overrides` reemplaza lo que el caso necesita simular.
  const controller = createPairingController({ ...api, ...overrides }, () => 1_000);
  return { api, controller, vehicle, state: () => controller.store.getState() };
}

const apiError = (status: number, code: string) => new ApiRequestError(status, code, "x", null);

describe("catálogo", () => {
  it("carga el catálogo ordenado por placa de forma natural", async () => {
    const listVehicles = vi.fn<Api["listVehicles"]>(() =>
      Promise.resolve({ items: [catalogItem({ plate: "NRT10" }), catalogItem({ plate: "NRT2" })], limit: 500 }),
    );
    const { controller, state } = setup({ listVehicles });
    await controller.loadCatalog();
    expect(state().catalog.data?.map((item) => item.plate)).toEqual(["NRT2", "NRT10"]);
    expect(state().catalog.status).toBe("ready");
    expect(listVehicles).toHaveBeenCalledWith(500, expect.any(AbortSignal));
  });

  it("si la recarga falla conserva la lista anterior y muestra el error", async () => {
    const { controller, api, state } = setup();
    await controller.loadCatalog();
    api.listVehicles.mockRejectedValueOnce(new NetworkError());
    await controller.loadCatalog();
    expect(state().catalog.data).toHaveLength(1);
    expect(state().catalog.error).toMatch(/No se pudo conectar/);
    expect(state().catalog.updatedAt).toBe(1_000);
  });

  it("solo vale la última carga: la respuesta tardía de una anterior se descarta", async () => {
    let resolveFirst: (value: { items: ReturnType<typeof catalogItem>[]; limit: number }) => void = () => undefined;
    const listVehicles = vi
      .fn<Api["listVehicles"]>()
      .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
      .mockResolvedValueOnce({ items: [catalogItem({ plate: "NUEVA1" })], limit: 500 });
    const { controller, state } = setup({ listVehicles });
    const first = controller.loadCatalog();
    await controller.loadCatalog();
    resolveFirst({ items: [catalogItem({ plate: "VIEJA1" })], limit: 500 });
    await first;
    expect(state().catalog.data?.map((item) => item.plate)).toEqual(["NUEVA1"]);
  });

  it("sortCatalog y withoutDevice", () => {
    const items = [catalogItem({ plate: "B2", hasActiveDevice: true }), catalogItem({ plate: "A1" })];
    expect(sortCatalog(items).map((item) => item.plate)).toEqual(["A1", "B2"]);
    expect(withoutDevice(items)).toBe(1);
  });
});

describe("vincular un vehículo del catálogo", () => {
  it("genera el código y refresca el catálogo", async () => {
    const { controller, api, state, vehicle } = setup();
    await controller.loadCatalog();
    await controller.pair(vehicle.vehicleId);
    expect(state().submit).toBe("done");
    expect(state().result).toEqual({ code: pairingCode(vehicle.vehicleId), plate: "NRT101" });
    expect(api.createPairingCode).toHaveBeenCalledWith(vehicle.vehicleId, expect.any(AbortSignal));
    expect(api.listVehicles).toHaveBeenCalledTimes(2);
  });

  it("sin vehículo elegido o ajeno al catálogo no llama a la API", async () => {
    const { controller, api, state } = setup();
    await controller.loadCatalog();
    await controller.pair("00000000-0000-4000-8000-000000000000");
    expect(state().error).toBe("Elige un vehículo.");
    expect(api.createPairingCode).not.toHaveBeenCalled();
  });

  it.each([
    [apiError(404, "not_found"), /no existe o no pertenece/],
    [apiError(429, "rate_limited"), /Demasiadas solicitudes/],
    [apiError(400, "validation"), /Elige un vehículo válido/],
    [new UnauthorizedError(), /sesión terminó/],
    [new NetworkError(), /No se pudo conectar/],
  ])("el error del código se explica con claridad (%#)", async (error, message) => {
    const { controller, vehicle, state } = setup({ createPairingCode: vi.fn(() => Promise.reject(error)) });
    await controller.loadCatalog();
    await controller.pair(vehicle.vehicleId);
    expect(state().submit).toBe("failed");
    expect(state().error).toMatch(message);
    expect(state().result).toBeNull();
  });
});

describe("nuevo vehículo", () => {
  it("crea con la placa normalizada y genera el código en el mismo paso, y refresca el catálogo", async () => {
    const { controller, api, state } = setup();
    await controller.loadCatalog();
    await controller.createAndPair("  abc123 ", "  Camión 3 ");
    expect(api.createVehicle).toHaveBeenCalledWith({ plate: "ABC123", label: "Camión 3" }, expect.any(AbortSignal));
    expect(api.createPairingCode).toHaveBeenCalledTimes(1);
    expect(state().submit).toBe("done");
    expect(state().result?.plate).toBe("ABC123");
    expect(api.listVehicles).toHaveBeenCalledTimes(2);
  });

  it("el nombre vacío se envía como null", async () => {
    const { controller, api } = setup();
    await controller.createAndPair("ABC123", "   ");
    expect(api.createVehicle).toHaveBeenCalledWith({ plate: "ABC123", label: null }, expect.any(AbortSignal));
  });

  it.each([["", /Escribe la placa/], ["AB#1", /solo lleva letras y dígitos/], ["A".repeat(33), /La placa admite hasta 32 caracteres/]])(
    "placa inválida %j: se valida antes de enviar y no se llama a la API",
    async (plate, message) => {
      const { controller, api, state } = setup();
      await controller.createAndPair(plate, "");
      expect(state().plateError).toMatch(message);
      expect(state().submit).toBe("failed");
      expect(api.createVehicle).not.toHaveBeenCalled();
    },
  );

  it("un nombre demasiado largo se rechaza antes de enviar", async () => {
    const { controller, api, state } = setup();
    await controller.createAndPair("ABC123", "x".repeat(65));
    expect(state().labelError).toMatch(/hasta 64/);
    expect(api.createVehicle).not.toHaveBeenCalled();
  });

  it("409 plate_taken: recarga el catálogo, deja elegida la placa existente y avisa; no genera código", async () => {
    const existing = catalogItem({ plate: "ABC123", label: "Ya estaba" });
    const listVehicles = vi.fn<Api["listVehicles"]>(() => Promise.resolve({ items: [existing], limit: 500 }));
    const createPairingCode = vi.fn<Api["createPairingCode"]>();
    const { controller, state } = setup({
      listVehicles,
      createPairingCode,
      createVehicle: vi.fn(() => Promise.reject(apiError(409, PLATE_TAKEN_ERROR_CODE))),
    });
    await controller.createAndPair("abc-123", "");
    expect(listVehicles).toHaveBeenCalledTimes(1);
    expect(state().suggestedVehicleId).toBe(existing.vehicleId);
    expect(state().error).toBe("Ya existe un vehículo con esa placa. La seleccionamos para que generes su código.");
    expect(state().plateError).toBeNull();
    expect(createPairingCode).not.toHaveBeenCalled();
  });

  it("409 plate_taken sin la placa en el catálogo recargado: el error queda en el campo placa y no se sugiere nada", async () => {
    const { controller, state } = setup({ createVehicle: vi.fn(() => Promise.reject(apiError(409, PLATE_TAKEN_ERROR_CODE))) });
    await controller.createAndPair("ZZZ999", "");
    expect(state().plateError).toBe("Ya existe un vehículo con esa placa.");
    expect(state().suggestedVehicleId).toBeNull();
    expect(state().error).toBeNull();
  });

  it("400 del servidor va al campo placa; 429, 401 y 5xx son avisos generales", async () => {
    const run = async (error: unknown) => {
      const { controller, state } = setup({ createVehicle: vi.fn<Api["createVehicle"]>().mockRejectedValue(error) });
      await controller.createAndPair("ABC123", "");
      return state();
    };
    expect((await run(apiError(400, "validation"))).plateError).toMatch(/Revisa la placa/);
    expect((await run(apiError(400, "validation"))).error).toBeNull();
    expect((await run(apiError(429, "rate_limited"))).error).toMatch(/Demasiadas solicitudes/);
    expect((await run(new UnauthorizedError())).error).toMatch(/sesión terminó/);
    expect((await run(apiError(500, "boom"))).error).toMatch(/No se pudo crear el vehículo/);
  });

  it("el vehículo creado entra al catálogo local y queda sugerido aunque falle el código Y el refresco", async () => {
    const created = catalogItem({ plate: "ABC123" });
    const existing = catalogItem({ plate: "ZZZ001" });
    const listVehicles = vi
      .fn<Api["listVehicles"]>()
      .mockResolvedValueOnce({ items: [existing], limit: 500 })
      .mockRejectedValue(new NetworkError());
    const { controller, state } = setup({
      listVehicles,
      createVehicle: vi.fn(() => Promise.resolve(created)),
      createPairingCode: vi.fn(() => Promise.reject(new NetworkError())),
    });
    await controller.loadCatalog();
    await controller.createAndPair("ABC123", "");
    await vi.waitFor(() => expect(state().catalog.error).not.toBeNull());
    expect(state().submit).toBe("failed");
    expect(state().error).toMatch(/El vehículo se creó, pero no se pudo generar el código/);
    expect(state().suggestedVehicleId).toBe(created.vehicleId);
    // El refresco falló, pero el selector tiene el vehículo (y ordenado por placa).
    expect(state().catalog.data?.map((item) => item.plate)).toEqual(["ABC123", "ZZZ001"]);
  });

  it("al desmontar se cancela lo pendiente y nada se aplica después", async () => {
    let signal: AbortSignal | undefined;
    const createVehicle = vi.fn<Api["createVehicle"]>(
      (_request, abortSignal) =>
        new Promise((_resolve, reject) => {
          signal = abortSignal;
          abortSignal?.addEventListener("abort", () => reject(new DOMException("cancelada", "AbortError")));
        }),
    );
    const { controller, state, api } = setup({ createVehicle });
    const pending = controller.createAndPair("ABC123", "");
    controller.dispose();
    await pending;
    expect(signal?.aborted).toBe(true);
    expect(state().submit).toBe("submitting");
    expect(api.createPairingCode).not.toHaveBeenCalled();
  });
});

describe("validateVehicleForm", () => {
  it("normaliza la placa con el esquema del contrato", () => {
    expect(validateVehicleForm(" abc12d ", "")).toEqual({ ok: true, request: { plate: "ABC12D", label: null } });
    // Forma canónica del contrato: sin espacios ni guiones, así que son la misma placa.
    expect(validateVehicleForm("abc-12 3", "")).toEqual({ ok: true, request: { plate: "ABC123", label: null } });
  });

  it("un nombre con caracteres de control se rechaza antes de enviar", () => {
    const result = validateVehicleForm("ABC123", "Camión\u0000");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.labelError).toMatch(/control/);
  });
});
