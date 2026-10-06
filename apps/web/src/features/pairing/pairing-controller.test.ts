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

  it.each([["", /Escribe la placa/], ["AB#1", /solo lleva letras y dígitos/], ["A".repeat(33), /solo lleva letras/]])(
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

  it("409 plate_taken: 'Ya existe un vehículo con esa placa' y no genera código", async () => {
    const { controller, api, state } = setup({ createVehicle: vi.fn(() => Promise.reject(apiError(409, PLATE_TAKEN_ERROR_CODE))) });
    await controller.createAndPair("ABC123", "");
    expect(state().error).toBe("Ya existe un vehículo con esa placa.");
    expect(api.createPairingCode).not.toHaveBeenCalled();
  });

  it.each([
    [apiError(429, "rate_limited"), /Demasiadas solicitudes/],
    [apiError(400, "validation"), /Revisa la placa/],
    [new UnauthorizedError(), /sesión terminó/],
    [apiError(500, "boom"), /No se pudo crear el vehículo/],
  ])("el error de alta se explica con claridad (%#)", async (error, message) => {
    const { controller, state } = setup({ createVehicle: vi.fn(() => Promise.reject(error)) });
    await controller.createAndPair("ABC123", "");
    expect(state().error).toMatch(message);
  });

  it("si el vehículo se crea pero el código falla, lo dice, refresca el catálogo y deja elegido el vehículo para reintentar", async () => {
    const { controller, api, state } = setup({ createPairingCode: vi.fn(() => Promise.reject(new NetworkError())) });
    await controller.createAndPair("ABC123", "");
    expect(state().submit).toBe("failed");
    expect(state().error).toMatch(/El vehículo se creó, pero no se pudo generar el código/);
    expect(state().createdVehicleId).not.toBeNull();
    expect(api.listVehicles).toHaveBeenCalledTimes(1);
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
