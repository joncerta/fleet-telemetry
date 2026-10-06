/**
 * Error con estado HTTP para cortar la petición desde un hook (401, 429...). `mapError` lo traduce a su código de API
 * por el estado, con un mensaje fijo: el mensaje de esta clase nunca llega al cliente.
 */
export class HttpStatusError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "HttpStatusError";
    this.statusCode = statusCode;
  }
}
