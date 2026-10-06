import type { PairingResult } from "./pairing-controller";

/** Lo que del estado del controlador decide qué hace el formulario: el vehículo a elegir y el último código. */
export interface FormSignals {
  readonly suggestedVehicleId: string | null;
  readonly result: PairingResult | null;
}

export interface FormChange {
  /** Vehículo que el selector debe pasar a mostrar (el creado cuyo código falló, o el existente tras un 409), o `null` si no cambia. */
  readonly selection: string | null;
  /** Vaciar placa y nombre: el alta salió bien y el código se ve en el resultado. */
  readonly clearForm: boolean;
}

/**
 * Qué cambia en el formulario cuando el estado del controlador pasa de `prev` a `next`. Pura: solo reacciona a una sugerencia NUEVA
 * (el controlador la borra al empezar cada envío, así que repetirla vuelve a elegir) y a un resultado nuevo estando en "Nuevo vehículo".
 */
export function nextFormState(prev: FormSignals, next: FormSignals, creating: boolean): FormChange {
  const selection = next.suggestedVehicleId !== null && next.suggestedVehicleId !== prev.suggestedVehicleId ? next.suggestedVehicleId : null;
  const clearForm = next.result !== null && next.result !== prev.result && creating;
  return { selection, clearForm };
}
