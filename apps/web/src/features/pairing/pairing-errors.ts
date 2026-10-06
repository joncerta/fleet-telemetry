import { ApiRequestError, NetworkError } from "../../lib/api/http-client";

/** Mensaje para el usuario cuando no se pudo crear el código de vinculación. */
export function pairingErrorMessage(error: unknown): string {
  if (error instanceof NetworkError) return "No se pudo conectar con el servidor. Inténtalo de nuevo.";
  if (error instanceof ApiRequestError) {
    if (error.status === 404) return "Ese vehículo no existe o no pertenece a tu flota.";
    if (error.status === 429) return "Demasiadas solicitudes. Espera un momento e inténtalo de nuevo.";
    if (error.status === 400) return "Elige un vehículo válido.";
  }
  return "No se pudo generar el código. Inténtalo de nuevo.";
}
