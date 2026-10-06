/** Errores de negocio del agente. La entrada HTTP los traduce con mensajes fijos: el mensaje de estas clases nunca llega al cliente. */

/** La pregunta no se respondió dentro del tiempo total permitido. */
export class AgentTimeoutError extends Error {
  constructor() {
    super("El agente superó el tiempo total permitido.");
    this.name = "AgentTimeoutError";
  }
}

/** El agente no pudo responder (el modelo falló, superó el límite de pasos...). El detalle va al log, nunca al cliente. */
export class AgentFailedError extends Error {
  constructor(options?: { cause: unknown }) {
    super("El agente no pudo responder.", options);
    this.name = "AgentFailedError";
  }
}
