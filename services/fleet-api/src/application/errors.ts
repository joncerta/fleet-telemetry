/** Errores de negocio de fleet-api. La entrada HTTP los traduce con mensajes fijos: el mensaje de estas clases nunca llega al cliente. */

/** Correo o contraseña incorrectos. Una sola clase para "no existe" y "contraseña errónea": no se distinguen. */
export class InvalidCredentialsError extends Error {
  constructor() {
    super("Credenciales inválidas.");
    this.name = "InvalidCredentialsError";
  }
}

/** La identidad de la sesión ya no existe (usuario borrado o de otro tenant). Equivale a no estar autenticado. */
export class SessionInvalidError extends Error {
  constructor() {
    super("La sesión ya no es válida.");
    this.name = "SessionInvalidError";
  }
}

/** El vehículo no existe o no es del tenant de la sesión. No se distingue: un vehículo ajeno no debe revelarse. */
export class VehicleNotFoundError extends Error {
  constructor() {
    super("Vehículo no encontrado.");
    this.name = "VehicleNotFoundError";
  }
}

/** El código de vinculación no existe, ya se usó o venció. No se distingue ningún caso: no ayuda a quien adivina códigos. */
export class InvalidPairingCodeError extends Error {
  constructor() {
    super("Código de vinculación inválido.");
    this.name = "InvalidPairingCodeError";
  }
}

/** Invariante rota del lado del servidor (no culpa del cliente): sube como 500. */
export class PairingInconsistencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PairingInconsistencyError";
  }
}
