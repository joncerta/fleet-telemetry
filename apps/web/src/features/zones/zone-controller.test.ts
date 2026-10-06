import { describe, expect, it, vi } from "vitest";
import { ApiRequestError, NetworkError, UnauthorizedError } from "../../lib/api/http-client";
import { createZoneController, type ZoneControllerDeps } from "./zone-controller";
import { INVALID_GEOMETRY_ERROR_CODE, ZONE_LIMIT_REACHED_ERROR_CODE, ZONE_MAX_PER_TENANT, ZONE_NAME_MAX_LENGTH, ZONE_NAME_TAKEN_ERROR_CODE, type ZoneFeatureTolerant as ZoneFeature } from "@fleet/contracts";
import type { CreateZone } from "./zone-controller";
import { createZoneDrawingStore } from "./zone-drawing-store";
import { INVALID_GEOMETRY_MESSAGE, NAME_TAKEN_MESSAGE } from "./zone-errors";

const feature = (name: string): ZoneFeature => ({
  type: "Feature",
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [-74.1, 4.6],
        [-74.0, 4.6],
        [-74.0, 4.7],
        [-74.1, 4.6],
      ],
    ],
  },
  properties: { zoneId: "f1ee7000-0000-4000-a000-000000000099", name, kind: "depot" },
});

function setup(createZone?: CreateZone, closed = true) {
  const drawing = createZoneDrawingStore();
  drawing.getState().start();
  if (closed) {
    for (const vertex of [
      [-74.1, 4.6],
      [-74.0, 4.6],
      [-74.0, 4.7],
    ] as const)
      drawing.getState().addVertex(vertex);
    drawing.getState().close();
  }
  const create = vi.fn<CreateZone>(createZone ?? ((request) => Promise.resolve(feature(request.name))));
  const onCreated = vi.fn<ZoneControllerDeps["onCreated"]>();
  const onNeedsReload = vi.fn();
  const controller = createZoneController({ createZone: create, drawing, onCreated, onNeedsReload });
  return { drawing, create, onCreated, onNeedsReload, controller, state: () => controller.store.getState(), phase: () => drawing.getState().drawing.phase };
}

const apiError = (status: number, code: string) => new ApiRequestError(status, code, "x", null);

describe("guardar", () => {
  it("envía el anillo cerrado en [lng, lat] con el nombre recortado y termina el dibujo", async () => {
    const { controller, create, onCreated, state, phase } = setup();
    await controller.save("  Bodega Norte  ", "depot");
    expect(create).toHaveBeenCalledWith(
      {
        name: "Bodega Norte",
        kind: "depot",
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [-74.1, 4.6],
              [-74.0, 4.6],
              [-74.0, 4.7],
              [-74.1, 4.6],
            ],
          ],
        },
      },
      expect.any(AbortSignal),
    );
    expect(onCreated).toHaveBeenCalledWith(feature("Bodega Norte"));
    expect(phase()).toBe("idle");
    expect(state()).toEqual({ submit: "idle", error: null, nameError: null, createdName: "Bodega Norte" });
  });

  it("pasa a guardando mientras espera y no envía dos veces", async () => {
    let resolve: (value: ZoneFeature) => void = () => undefined;
    const { controller, create, phase, state } = setup(() => new Promise<ZoneFeature>((r) => (resolve = r)));
    const first = controller.save("A", "critical");
    void controller.save("A", "critical");
    expect(state().submit).toBe("submitting");
    expect(phase()).toBe("saving");
    expect(create).toHaveBeenCalledTimes(1);
    resolve(feature("A"));
    await first;
  });

  it("sin anillo cerrado no hace nada", async () => {
    const { controller, create } = setup(undefined, false);
    await controller.save("A", "critical");
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ["", "El nombre de la zona no puede estar vacío."],
    ["   ", "El nombre de la zona no puede estar vacío."],
    ["x".repeat(ZONE_NAME_MAX_LENGTH + 1), `El nombre admite a lo sumo ${String(ZONE_NAME_MAX_LENGTH)} caracteres.`],
    ["Zona\u0007", "El nombre no admite caracteres de control, de formato ni de dirección de texto."],
    ["Zona​X", "El nombre no admite caracteres de control, de formato ni de dirección de texto."],
  ])("valida el nombre %j antes de enviar", async (name, message) => {
    const { controller, create, state, phase } = setup();
    await controller.save(name, "critical");
    expect(create).not.toHaveBeenCalled();
    expect(state()).toMatchObject({ submit: "failed", nameError: message });
    expect(phase()).toBe("closed");
  });

  it("acepta un nombre de exactamente el máximo", async () => {
    const { controller, create } = setup();
    await controller.save("x".repeat(ZONE_NAME_MAX_LENGTH), "critical");
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("errores", () => {
  const failing = (error: Error) => () => Promise.reject(error);

  it("409 zone_name_taken: error en el campo nombre y el polígono sigue cerrado", async () => {
    const { controller, state, phase, onCreated } = setup(failing(apiError(409, ZONE_NAME_TAKEN_ERROR_CODE)));
    await controller.save("Norte", "critical");
    expect(state()).toEqual({ submit: "failed", error: null, nameError: NAME_TAKEN_MESSAGE, createdName: null });
    expect(NAME_TAKEN_MESSAGE).toBe("Ya existe una zona con ese nombre.");
    expect(phase()).toBe("closed");
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("400 invalid_geometry: aviso general sobre el polígono", async () => {
    const { controller, state } = setup(failing(apiError(400, INVALID_GEOMETRY_ERROR_CODE)));
    await controller.save("Norte", "critical");
    expect(state()).toEqual({ submit: "failed", error: INVALID_GEOMETRY_MESSAGE, nameError: null, createdName: null });
    expect(INVALID_GEOMETRY_MESSAGE).toContain("El polígono no es válido (se cruza consigo mismo)");
  });

  it("409 zone_limit_reached: aviso general con el máximo del contrato", async () => {
    const { controller, state, phase } = setup(failing(apiError(409, ZONE_LIMIT_REACHED_ERROR_CODE)));
    await controller.save("Norte", "critical");
    expect(state()).toEqual({ submit: "failed", error: `Se alcanzó el máximo de ${String(ZONE_MAX_PER_TENANT)} zonas para tu flota.`, nameError: null, createdName: null });
    expect(phase()).toBe("closed");
  });

  it("400 invalid_request: aviso general", async () => {
    const { controller, state } = setup(failing(apiError(400, "invalid_request")));
    await controller.save("Norte", "critical");
    expect(state().error).toMatch(/no aceptó la zona/);
  });

  it("429, 401, red y errores desconocidos tienen su mensaje", async () => {
    const cases: [Error, RegExp][] = [
      [apiError(429, "rate_limited"), /Demasiadas solicitudes/],
      [new UnauthorizedError(), /sesión terminó/],
      [new NetworkError(), /No se pudo conectar/],
      [apiError(500, "internal"), /No se pudo guardar la zona/],
      [apiError(501, "not_implemented"), /No se pudo guardar la zona/],
    ];
    for (const [error, message] of cases) {
      const { controller, state, phase } = setup(failing(error));
      await controller.save("Norte", "critical");
      expect(state().error).toMatch(message);
      expect(phase()).toBe("closed");
    }
  });

  it("un 409 o un corte de red piden releer las zonas; un 400 o un 429 no", async () => {
    const cases: [Error, boolean][] = [
      [apiError(409, ZONE_NAME_TAKEN_ERROR_CODE), true],
      [new NetworkError(), true],
      [apiError(400, "invalid_request"), false],
      [apiError(429, "rate_limited"), false],
    ];
    for (const [error, reloads] of cases) {
      const { controller, onNeedsReload } = setup(failing(error));
      await controller.save("Norte", "critical");
      expect(onNeedsReload).toHaveBeenCalledTimes(reloads ? 1 : 0);
    }
  });

  it("tras un error se puede reintentar", async () => {
    const create = vi.fn<CreateZone>().mockRejectedValueOnce(new NetworkError()).mockResolvedValueOnce(feature("Norte"));
    const { controller, phase, onCreated, state } = setup(create);
    await controller.save("Norte", "critical");
    await controller.save("Norte", "critical");
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(phase()).toBe("idle");
    expect(state().error).toBeNull();
  });
});

describe("cancelación", () => {
  it("dispose aborta la petición en curso, no avisa de nada y no deja el dibujo trabado en saving", async () => {
    let signal: AbortSignal | undefined;
    const { controller, onCreated, phase, state } = setup((_request, s) => {
      signal = s;
      return new Promise<ZoneFeature>((_resolve, reject) => s?.addEventListener("abort", () => reject(new DOMException("abort", "AbortError"))));
    });
    const pending = controller.save("Norte", "critical");
    expect(phase()).toBe("saving");
    controller.dispose();
    await pending;
    expect(signal?.aborted).toBe(true);
    expect(onCreated).not.toHaveBeenCalled();
    expect(phase()).toBe("idle");
    expect(state()).toEqual({ submit: "idle", error: null, nameError: null, createdName: null });
  });

  it("dispose durante el POST: aunque la respuesta llegue igual, onCreated no se llama y el dibujo sigue en idle", async () => {
    let resolve: (value: ZoneFeature) => void = () => undefined;
    const { controller, onCreated, phase, state } = setup(() => new Promise<ZoneFeature>((r) => (resolve = r)));
    const pending = controller.save("Norte", "critical");
    controller.dispose();
    resolve(feature("Norte"));
    await pending;
    expect(onCreated).not.toHaveBeenCalled();
    expect(phase()).toBe("idle");
    expect(state().createdName).toBeNull();
  });

  it("dispose durante un POST que falla tarde tampoco toca el dibujo ni muestra errores", async () => {
    let reject: (error: Error) => void = () => undefined;
    const { controller, state, phase, onNeedsReload } = setup(() => new Promise<ZoneFeature>((_r, rej) => (reject = rej)));
    const pending = controller.save("Norte", "critical");
    controller.dispose();
    reject(new NetworkError());
    await pending;
    expect(state().error).toBeNull();
    expect(phase()).toBe("idle");
    expect(onNeedsReload).not.toHaveBeenCalled();
  });

  it("el controlador sigue sirviendo tras un dispose (otra sesión en la misma pestaña)", async () => {
    const { controller, drawing, create, onCreated } = setup();
    controller.dispose();
    drawing.getState().start();
    for (const vertex of [
      [-75.6, 6.2],
      [-75.5, 6.2],
      [-75.5, 6.3],
    ] as const)
      drawing.getState().addVertex(vertex);
    drawing.getState().close();
    await controller.save("Sur", "depot");
    expect(create).toHaveBeenCalledTimes(1);
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it("clearFeedback quita los avisos, salvo mientras se guarda", async () => {
    const { controller, state } = setup(() => Promise.reject(new NetworkError()));
    await controller.save("Norte", "critical");
    controller.clearFeedback();
    expect(state()).toEqual({ submit: "idle", error: null, nameError: null, createdName: null });
  });
});
