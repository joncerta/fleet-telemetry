import { NO_SIGNAL_THRESHOLD_MS, type ZoneKind } from "@fleet/contracts";

const MINUTE_MS = 60_000;

/**
 * Instante a partir del cual un `receivedAt` cuenta como CON señal: un vehículo está sin señal si `receivedAt` es ANTERIOR a este
 * corte. Es la misma regla que `hasNoSignal` de @fleet/contracts (`serverTime - receivedAt > NO_SIGNAL_THRESHOLD_MS`) escrita como
 * un corte, para poder empujarla a una consulta (`received_at < $corte`) sin leer cada vehículo.
 */
export function noSignalCutoff(serverTime: Date): Date {
  return new Date(serverTime.getTime() - NO_SIGNAL_THRESHOLD_MS);
}

/** Minutos enteros detenido: `floor((serverTime - stoppedSince) / 60 s)`, la definición del contrato. Nunca negativo. */
export function stoppedMinutes(stoppedSince: Date, serverTime: Date): number {
  return Math.max(0, Math.floor((serverTime.getTime() - stoppedSince.getTime()) / MINUTE_MS));
}

/**
 * Corte de `stoppedSince` para "detenido al menos `minMinutes`": `stoppedMinutes >= minMinutes` equivale a
 * `stoppedSince <= corte`. Igual que `noSignalCutoff`, permite filtrar en la consulta con la misma regla.
 */
export function stoppedSinceCutoff(serverTime: Date, minMinutes: number): Date {
  return new Date(serverTime.getTime() - minMinutes * MINUTE_MS);
}

export interface ZoneRef {
  readonly zoneId: string;
  readonly name: string;
  readonly kind: ZoneKind;
}

/** Prioridad al elegir la zona que se muestra de un vehículo detenido: la crítica primero, luego cliente y depósito (ADR-006, pendiente). */
const ZONE_PRIORITY: Readonly<Record<ZoneKind, number>> = { critical: 0, customer: 1, depot: 2 };

/**
 * La zona que muestra un vehículo detenido cuando su posición está en varias: si se filtró por un tipo, solo cuentan las de ese
 * tipo; entre ellas, la crítica primero, luego cliente y depósito, y a igualdad el menor `zoneId` (determinista). `null` si no hay ninguna.
 */
export function pickDisplayZone(zones: readonly ZoneRef[], kind?: ZoneKind): ZoneRef | null {
  const candidates = kind === undefined ? zones : zones.filter((zone) => zone.kind === kind);
  const sorted = [...candidates].sort((a, b) => ZONE_PRIORITY[a.kind] - ZONE_PRIORITY[b.kind] || a.zoneId.localeCompare(b.zoneId));
  return sorted[0] ?? null;
}
