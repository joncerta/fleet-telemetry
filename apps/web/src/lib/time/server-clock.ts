/**
 * Hora del servidor estimada en el cliente. Los cálculos de "sin señal" y "minutos detenido" usan la hora del SERVIDOR, no el reloj del
 * navegador (que puede estar desfasado minutos): `offset = serverTime - relojLocal` al recibir una respuesta que trae `serverTime`.
 */

/** Desfase en ms entre la hora del servidor (`serverTimeIso`) y el reloj local al recibirla. `null` si la fecha no es válida. */
export function clockOffsetMs(serverTimeIso: string, clientNowMs: number): number | null {
  const server = Date.parse(serverTimeIso);
  return Number.isNaN(server) ? null : server - clientNowMs;
}

/** Hora del servidor estimada, en ms. */
export function serverNowMs(offsetMs: number, clientNowMs: number): number {
  return clientNowMs + offsetMs;
}

/** Milisegundos que faltan, según la hora del SERVIDOR (`serverNowMs`), para `targetIso`. Nunca negativo; una fecha inválida cuenta como ya vencida. */
export function msUntil(targetIso: string, serverNow: number): number {
  const target = Date.parse(targetIso);
  return Number.isNaN(target) ? 0 : Math.max(0, target - serverNow);
}

/** Minutos enteros transcurridos desde `sinceIso` hasta `nowMs` (nunca negativos: un reloj adelantado no da "-1 min"). */
export function minutesSince(sinceIso: string, nowMs: number): number {
  const since = Date.parse(sinceIso);
  if (Number.isNaN(since)) return 0;
  return Math.max(0, Math.floor((nowMs - since) / 60_000));
}
