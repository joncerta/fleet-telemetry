/**
 * Nombres del protocolo que el agente comparte con fleet-api.
 *
 * `SESSION_COOKIE_NAME` DEBE ser el mismo que emite fleet-api (`fleet_session`): el agente valida esa cookie y la reenvía. Si
 * cambian, el e2e del chat falla (401). El códec que la firma y la verifica es el de `@fleet/platform`.
 */
export const SESSION_COOKIE_NAME = "fleet_session";

/** Header HTTP del `correlationId`. */
export const CORRELATION_ID_HTTP_HEADER = "x-correlation-id";
