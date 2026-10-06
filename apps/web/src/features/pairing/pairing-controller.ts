import type { PairingCode, VehicleCatalogItem } from "@fleet/contracts";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { FleetApi } from "../../lib/api/fleet-api";
import { failed, idle, loading, ready, type Loadable } from "../../lib/loadable";
import { createdButNotPairedMessage, listErrorMessage, pairingErrorMessage, validateVehicleForm, vehicleCreateErrorMessage } from "./pairing-errors";

/** Tope del catálogo que pide el panel (el máximo del contrato). */
export const CATALOG_LIMIT = 500;

const byPlate = new Intl.Collator("es-CO", { numeric: true, sensitivity: "base" });

/** Catálogo ordenado por placa de forma natural (NRT2 antes que NRT10). */
export function sortCatalog(items: readonly VehicleCatalogItem[]): VehicleCatalogItem[] {
  return [...items].sort((a, b) => byPlate.compare(a.plate, b.plate));
}

/** Cuántos vehículos del catálogo no tienen dispositivo activo. */
export const withoutDevice = (items: readonly VehicleCatalogItem[]): number => items.filter((item) => !item.hasActiveDevice).length;

export interface PairingResult {
  readonly code: PairingCode;
  readonly plate: string;
}

export interface PairingState {
  readonly catalog: Loadable<VehicleCatalogItem[]>;
  /** `submitting`: creando el vehículo y/o generando el código. */
  readonly submit: "idle" | "submitting" | "done" | "failed";
  readonly error: string | null;
  /** Errores de validación del formulario "Nuevo vehículo", por campo. */
  readonly plateError: string | null;
  readonly labelError: string | null;
  readonly result: PairingResult | null;
  /** Vehículo creado cuyo código falló: la UI lo elige en la lista para reintentar. */
  readonly createdVehicleId: string | null;
}

const INITIAL: PairingState = {
  catalog: idle(),
  submit: "idle",
  error: null,
  plateError: null,
  labelError: null,
  result: null,
  createdVehicleId: null,
};

const CLEAN = { error: null, plateError: null, labelError: null, result: null, createdVehicleId: null } as const;

export interface PairingController {
  readonly store: StoreApi<PairingState>;
  /** (Re)carga el catálogo. Si falla, conserva la lista anterior con su hora y el error. */
  loadCatalog(): Promise<void>;
  /** Genera el código de un vehículo del catálogo (vincular de nuevo reemplaza el dispositivo). */
  pair(vehicleId: string): Promise<void>;
  /** Crea el vehículo y genera su código en el mismo paso; refresca el catálogo. */
  createAndPair(plate: string, label: string): Promise<void>;
  /** Quita avisos y resultado (al cambiar de opción en el formulario). */
  clearFeedback(): void;
  dispose(): void;
}

const isAbort = (error: unknown): boolean => error instanceof DOMException && error.name === "AbortError";

/** Estado y orquestación del panel "Vincular dispositivo", sin React: se prueba con un `fetch` falso. Los datos son del tenant de la sesión. */
export function createPairingController(
  api: Pick<FleetApi, "listVehicles" | "createVehicle" | "createPairingCode">,
  now: () => number = Date.now,
): PairingController {
  const store = createStore<PairingState>()(() => INITIAL);
  let catalogRequest: AbortController | null = null;
  let submitRequest: AbortController | null = null;

  const loadCatalog = async () => {
    catalogRequest?.abort();
    const request = new AbortController();
    catalogRequest = request;
    store.setState((state) => ({ catalog: loading(state.catalog) }));
    try {
      const response = await api.listVehicles(CATALOG_LIMIT, request.signal);
      if (catalogRequest !== request) return;
      store.setState({ catalog: ready(sortCatalog(response.items), now()) });
    } catch (error) {
      if (catalogRequest !== request || isAbort(error)) return;
      store.setState((state) => ({ catalog: failed(state.catalog, listErrorMessage("vehículos", error)) }));
    }
  };

  const beginSubmit = (): AbortController => {
    submitRequest?.abort();
    const request = new AbortController();
    submitRequest = request;
    store.setState({ ...CLEAN, submit: "submitting" });
    return request;
  };

  const pairVehicle = async (request: AbortController, vehicleId: string, plate: string, justCreated: boolean) => {
    try {
      const code = await api.createPairingCode(vehicleId, request.signal);
      if (submitRequest !== request) return;
      store.setState({ submit: "done", result: { code, plate } });
    } catch (error) {
      if (submitRequest !== request || isAbort(error)) return;
      store.setState(
        justCreated
          ? { submit: "failed", error: createdButNotPairedMessage(error), createdVehicleId: vehicleId }
          : { submit: "failed", error: pairingErrorMessage(error) },
      );
    }
    // El vehículo es nuevo o cambió su dispositivo: se vuelve a leer el catálogo, sin bloquear el resultado.
    if (justCreated || store.getState().submit === "done") void loadCatalog();
  };

  return {
    store,
    loadCatalog,
    async pair(vehicleId) {
      const plate = store.getState().catalog.data?.find((item) => item.vehicleId === vehicleId)?.plate;
      if (plate === undefined) {
        store.setState({ ...CLEAN, submit: "failed", error: "Elige un vehículo." });
        return;
      }
      await pairVehicle(beginSubmit(), vehicleId, plate, false);
    },
    async createAndPair(plate, label) {
      const form = validateVehicleForm(plate, label);
      if (!form.ok) {
        submitRequest?.abort();
        store.setState({ ...CLEAN, submit: "failed", plateError: form.plateError, labelError: form.labelError });
        return;
      }
      const request = beginSubmit();
      let created: VehicleCatalogItem;
      try {
        created = await api.createVehicle(form.request, request.signal);
      } catch (error) {
        if (submitRequest !== request || isAbort(error)) return;
        store.setState({ submit: "failed", error: vehicleCreateErrorMessage(error) });
        return;
      }
      if (submitRequest !== request) return;
      await pairVehicle(request, created.vehicleId, created.plate, true);
    },
    clearFeedback() {
      if (store.getState().submit === "submitting") return;
      store.setState({ ...CLEAN, submit: "idle" });
    },
    dispose() {
      catalogRequest?.abort();
      submitRequest?.abort();
      catalogRequest = null;
      submitRequest = null;
    },
  };
}
