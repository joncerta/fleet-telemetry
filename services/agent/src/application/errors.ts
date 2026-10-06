/** Errores de negocio del agente. La entrada HTTP los traduce con mensajes fijos: el mensaje de estas clases nunca llega al cliente. */

/** La pregunta no se respondió dentro del tiempo total permitido. */
export class AgentTimeoutError extends Error {
  constructor() {
    super("El agente superó el tiempo total permitido.");
    this.name = "AgentTimeoutError";
  }
}

/** Resumen SEGURO (sin mensajes ni datos de la pregunta) de por qué falló la llamada al proveedor del modelo; es lo que se loguea. */
export interface AgentFailureInfo {
  /** Clase del error del proveedor (`BadRequestError`, `AuthenticationError`...). */
  causeName: string;
  /** Código HTTP del proveedor, si lo hubo (un timeout o un corte de red no lo tienen). */
  causeStatus?: number;
  /** `error.type` de la respuesta del proveedor, de una lista cerrada (`invalid_request_error`, `authentication_error`...). */
  causeErrorType?: string;
  /** Id de la petición en el proveedor (`req_...`), para soporte. */
  providerRequestId?: string;
  /** El proveedor rechazó la configuración (clave revocada o sin permisos, modelo retirado): 401, 403 o 404. No abre el circuito. */
  providerMisconfigured: boolean;
}

/** El agente no pudo responder (el modelo falló, superó el límite de pasos...). El detalle va al log, nunca al cliente. */
export class AgentFailedError extends Error {
  /** Resumen seguro de la causa, calculado por el adaptador que envuelve el error. Es lo único de la causa que llega al log. */
  readonly failure: AgentFailureInfo | undefined;

  constructor(options?: { cause: unknown; failure?: AgentFailureInfo }) {
    super("El agente no pudo responder.", options === undefined ? undefined : { cause: options.cause });
    this.name = "AgentFailedError";
    this.failure = options?.failure;
  }
}

/** El cliente cerró la conexión (por ejemplo, la pestaña) antes de que terminara la pregunta: se cancela la corrida para no seguir pagando el modelo. */
export class AgentCancelledError extends Error {
  constructor() {
    super("La pregunta se canceló porque el cliente cerró la conexión.");
    this.name = "AgentCancelledError";
  }
}
