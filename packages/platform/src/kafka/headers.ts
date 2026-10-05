import { randomUUID } from "node:crypto";
import type { IHeaders } from "kafkajs";

/** Header de Kafka que lleva el `correlationId` de HTTP a través de todos los eventos (regla 16). */
export const CORRELATION_ID_HEADER = "correlationId";

/**
 * Formato permitido: 1 a 128 caracteres de `[A-Za-z0-9._:-]`. Un `correlationId` puede venir de un cliente (header
 * HTTP) y acaba en los logs de todos los servicios: se rechazan saltos de línea, espacios y texto arbitrario
 * (inyección de logs). Un UUID cumple el formato.
 */
export const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export const isValidCorrelationId = (value: string): boolean => CORRELATION_ID_PATTERN.test(value);

/** Headers que garantizan un `correlationId` con formato válido; es lo que exige el `send` de la fábrica. */
export type CorrelatedHeaders = IHeaders & { [CORRELATION_ID_HEADER]: string };

export class CorrelationIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorrelationIdError";
  }
}

/** Copia de los headers con el `correlationId` fijado; no muta los originales. Lanza si el formato no es válido. */
export function withCorrelationId(headers: IHeaders | undefined, correlationId: string): CorrelatedHeaders {
  if (!isValidCorrelationId(correlationId)) {
    throw new CorrelationIdError(`correlationId con formato inválido (se esperan 1-128 caracteres de [A-Za-z0-9._:-]).`);
  }
  return { ...headers, [CORRELATION_ID_HEADER]: correlationId };
}

/** Lee el `correlationId` de los headers de un mensaje, o `undefined` si no viene, está vacío o no cumple el formato. */
export function getCorrelationId(headers: IHeaders | undefined): string | undefined {
  const raw = headers?.[CORRELATION_ID_HEADER];
  const first = Array.isArray(raw) ? raw[0] : raw;
  const value = first?.toString();
  return value !== undefined && isValidCorrelationId(value) ? value : undefined;
}

/** El `correlationId` del mensaje o, si el origen no lo mandó o venía inválido, uno nuevo para no perder la traza desde aquí. */
export function resolveCorrelationId(headers: IHeaders | undefined): string {
  return getCorrelationId(headers) ?? randomUUID();
}
