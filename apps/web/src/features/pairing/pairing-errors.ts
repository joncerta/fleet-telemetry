import { PLATE_MAX_LENGTH, PLATE_TAKEN_ERROR_CODE, VEHICLE_LABEL_MAX_LENGTH, vehicleCreateRequestSchema, type VehicleCreateRequest } from "@fleet/contracts";
import { ApiRequestError, InvalidResponseError, NetworkError, UnauthorizedError } from "../../lib/api/http-client";

const RATE_LIMITED = "Demasiadas solicitudes. Espera un momento e inténtalo de nuevo.";
const NO_CONNECTION = "No se pudo conectar con el servidor. Inténtalo de nuevo.";
const SESSION_ENDED = "Tu sesión terminó. Vuelve a ingresar.";

/** Mensaje para el usuario cuando no se pudo crear el código de vinculación. */
export function pairingErrorMessage(error: unknown): string {
  if (error instanceof NetworkError) return NO_CONNECTION;
  if (error instanceof UnauthorizedError) return SESSION_ENDED;
  if (error instanceof ApiRequestError) {
    if (error.status === 404) return "Ese vehículo no existe o no pertenece a tu flota.";
    if (error.status === 429) return RATE_LIMITED;
    if (error.status === 400) return "Elige un vehículo válido.";
  }
  return "No se pudo generar el código. Inténtalo de nuevo.";
}

export const PLATE_TAKEN_MESSAGE = "Ya existe un vehículo con esa placa.";

export interface VehicleCreateFailure {
  readonly message: string;
  /** El mensaje es del campo placa (409 y 400): va en `plateError`, con `aria-invalid` y `aria-describedby`; si no, es un aviso general. */
  readonly field: "plate" | null;
  /** 409 `plate_taken`: la placa ya existe en el catálogo. */
  readonly plateTaken: boolean;
}

/** Cómo mostrar el fallo del alta (`POST /v1/vehicles`). */
export function vehicleCreateFailure(error: unknown): VehicleCreateFailure {
  const general = (message: string): VehicleCreateFailure => ({ message, field: null, plateTaken: false });
  if (error instanceof NetworkError) return general(NO_CONNECTION);
  if (error instanceof UnauthorizedError) return general(SESSION_ENDED);
  if (error instanceof ApiRequestError) {
    if (error.status === 409 && error.code === PLATE_TAKEN_ERROR_CODE) return { message: PLATE_TAKEN_MESSAGE, field: "plate", plateTaken: true };
    if (error.status === 429) return general(RATE_LIMITED);
    if (error.status === 400) return { message: "Revisa la placa y el nombre: el servidor no los aceptó.", field: "plate", plateTaken: false };
  }
  return general("No se pudo crear el vehículo. Inténtalo de nuevo.");
}

/** Mensaje cuando el vehículo SÍ se creó pero no se pudo generar su código (se puede reintentar eligiéndolo en la lista). */
export function createdButNotPairedMessage(error: unknown): string {
  return `El vehículo se creó, pero no se pudo generar el código. ${pairingErrorMessage(error)} Elígelo en la lista para reintentar.`;
}

/** Mensaje cuando no se pudo leer una lista (catálogo, usuarios). */
export function listErrorMessage(what: "vehículos" | "usuarios", error: unknown): string {
  if (error instanceof UnauthorizedError) return SESSION_ENDED;
  if (error instanceof NetworkError) return `No se pudo conectar para cargar los ${what}.`;
  if (error instanceof ApiRequestError && error.status === 429) return RATE_LIMITED;
  if (error instanceof InvalidResponseError) return `La lista de ${what} llegó con un formato inesperado.`;
  return `No se pudieron cargar los ${what}.`;
}

export type VehicleFormResult = { ok: true; request: VehicleCreateRequest } | { ok: false; plateError: string | null; labelError: string | null };

/** Valida el formulario con el esquema del contrato ANTES de enviar (normaliza la placa: trim y mayúsculas; un nombre vacío es null). */
export function validateVehicleForm(plate: string, label: string): VehicleFormResult {
  const parsed = vehicleCreateRequestSchema.safeParse({ plate, label });
  if (parsed.success) return { ok: true, request: parsed.data };
  let plateError: string | null = null;
  let labelError: string | null = null;
  for (const issue of parsed.error.issues) {
    if (issue.path[0] === "label") {
      labelError ??= `El nombre admite hasta ${String(VEHICLE_LABEL_MAX_LENGTH)} caracteres, sin caracteres de control.`;
    } else if (issue.code === "too_big") {
      plateError ??= `La placa admite hasta ${String(PLATE_MAX_LENGTH)} caracteres.`;
    } else {
      plateError ??= plate.trim() === "" ? "Escribe la placa." : "La placa solo lleva letras y dígitos (por ejemplo ABC123).";
    }
  }
  return { ok: false, plateError, labelError };
}
