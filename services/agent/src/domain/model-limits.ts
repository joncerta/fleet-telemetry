/**
 * Límites de las llamadas al proveedor del modelo. Módulo sin dependencias de infraestructura: lo comparten la configuración (que valida
 * que quepan en el tiempo total de una pregunta) y el adaptador del modelo (que los aplica).
 */

/**
 * Reintentos del cliente de LangChain ante un fallo del proveedor. Su valor por defecto es 6: con Anthropic caído, cada paso del agente
 * mandaría hasta 7 peticiones. Con 1, un fallo pasajero se absorbe y uno sostenido llega pronto al breaker.
 */
export const MODEL_MAX_RETRIES = 1;

/**
 * Presupuesto para las esperas del cliente entre un intento y su reintento (backoff). NO es una garantía de la librería (un `Retry-After`
 * del proveedor puede pedir más): el tope duro es el deadline de la llamada, que la aborta aunque el cliente siga durmiendo.
 */
export const RETRY_BACKOFF_ALLOWANCE_MS = 5_000;

/** Deadline de UNA llamada del bucle al modelo: sus intentos (con el timeout de cada petición) más el presupuesto de backoff. */
export const modelCallDeadlineMs = (callTimeoutMs: number): number => callTimeoutMs * (MODEL_MAX_RETRIES + 1) + RETRY_BACKOFF_ALLOWANCE_MS;
