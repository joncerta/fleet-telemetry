import { randomUUID } from "node:crypto";
import { isValidCorrelationId } from "@fleet/platform";

/**
 * `correlationId` de la petición: el del header `x-correlation-id` si cumple el formato de la plataforma (1 a 128
 * caracteres de `[A-Za-z0-9._:-]`), o uno nuevo. Un valor inválido no rechaza la petición: se descarta y se genera otro,
 * porque el header viene del cliente y acaba en los logs de todos los servicios (inyección de logs).
 */
export function resolveCorrelationId(header: string | string[] | undefined): string {
  return typeof header === "string" && isValidCorrelationId(header) ? header : randomUUID();
}
