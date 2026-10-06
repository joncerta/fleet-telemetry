/**
 * Detalles de un registro: solo nombres de evento, rutas, códigos y contadores. El tipo no admite objetos (`unknown`) a propósito: un
 * payload (posición, placa, correo) no cabe por error. Privacidad, Ley 1581 (regla 14).
 */
export type LogDetails = Readonly<Record<string, string | number | boolean | readonly string[]>>;

export type LogFn = (message: string, details?: LogDetails) => void;

/** Registro de diagnóstico del cliente, nunca con datos personales (ver `LogDetails`). */
export const logWarn: LogFn = (message, details) => {
  console.warn(`[fleet-web] ${message}`, details ?? {});
};
