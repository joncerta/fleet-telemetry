import { ApiRequestError, NetworkError, UnauthorizedError } from "../../lib/api/http-client";

/**
 * Mensaje para el usuario por un login fallido. Un 401 es genérico (el servidor no dice si el correo existe, y la web tampoco). Nunca
 * repite lo que el usuario escribió.
 */
export function loginErrorMessage(error: unknown): string {
  if (error instanceof UnauthorizedError) return "Correo o contraseña incorrectos.";
  if (error instanceof NetworkError) return "No se pudo conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.";
  if (error instanceof ApiRequestError && error.status === 429) {
    const minutes = error.retryAfterSeconds === null ? null : Math.max(1, Math.ceil(error.retryAfterSeconds / 60));
    return minutes === null
      ? "Demasiados intentos. Espera unos minutos e inténtalo de nuevo."
      : `Demasiados intentos. Inténtalo de nuevo en ${minutes} min.`;
  }
  if (error instanceof ApiRequestError && error.status === 400) return "Revisa el correo y la contraseña.";
  return "No se pudo iniciar sesión. Inténtalo de nuevo.";
}
