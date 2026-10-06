import type { AlertsResponseTolerant, FleetSummary, StoppedVehiclesResponseTolerant } from "@fleet/contracts";

/**
 * Lo que el LLM ve de lo que devuelve fleet-api: una proyección ACOTADA en filas y en campos.
 *
 * - Solo lo que hace falta para responder. No se envían coordenadas, `vehicleId` ni identificadores de zona: la posición es un
 *   dato personal (Ley 1581) y el modelo es un tercero. La placa sí va: es lo que el usuario pregunta.
 * - Los textos que vienen de la base (placas, nombres de zona) son DATOS, no instrucciones: se limpian de saltos de línea y
 *   caracteres de control y se acortan, para que no puedan llevar un prompt largo ni fingir que cierran una sección.
 */

/** Largo máximo de un texto de la base (placa, nombre de zona) que llega al modelo. */
export const MAX_TEXT_LENGTH = 64;

/** Filas máximas que llegan al modelo en una consulta, aunque la herramienta pida menos o fleet-api devuelva más. */
export const MAX_ROWS = 50;

/** Un texto de la base apto para el modelo: sin caracteres de control (incluye saltos de línea) y de a lo sumo `MAX_TEXT_LENGTH`. */
export function sanitizeText(value: string): string {
  const clean = value.replaceAll(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replaceAll(/\s+/g, " ").trim();
  return clean.length > MAX_TEXT_LENGTH ? `${clean.slice(0, MAX_TEXT_LENGTH - 1)}…` : clean;
}

export interface StoppedVehicleView {
  readonly plate: string;
  readonly stoppedMinutes: number;
  readonly zoneName: string | null;
  readonly zoneKind: string | null;
}

export interface StoppedVehiclesView {
  /** Filas incluidas. */
  readonly count: number;
  /** `true` si se llegó al tope pedido: puede haber más vehículos de los listados. */
  readonly mayHaveMore: boolean;
  readonly vehicles: readonly StoppedVehicleView[];
}

export function toStoppedVehiclesView(response: StoppedVehiclesResponseTolerant, limit: number): StoppedVehiclesView {
  const cap = Math.min(limit, MAX_ROWS);
  const vehicles = response.items.slice(0, cap).map((item) => ({
    plate: sanitizeText(item.plate),
    stoppedMinutes: item.stoppedMinutes,
    zoneName: item.zone === null ? null : sanitizeText(item.zone.name),
    zoneKind: item.zone === null ? null : item.zone.kind,
  }));
  return { count: vehicles.length, mayHaveMore: response.items.length >= cap, vehicles };
}

export interface FleetSummaryView {
  readonly total: number;
  readonly moving: number;
  readonly stopped: number;
  readonly noSignal: number;
  readonly activeAlerts: number;
}

export function toFleetSummaryView(summary: FleetSummary): FleetSummaryView {
  return { ...summary.vehicles, activeAlerts: summary.activeAlerts };
}

export interface AlertView {
  readonly plate: string;
  readonly type: string;
  readonly zoneName: string | null;
  readonly startedAt: string;
}

export interface AlertsView {
  readonly count: number;
  readonly mayHaveMore: boolean;
  readonly alerts: readonly AlertView[];
}

export function toAlertsView(response: AlertsResponseTolerant, limit: number): AlertsView {
  const cap = Math.min(limit, MAX_ROWS);
  const alerts = response.items.slice(0, cap).map((alert) => ({
    plate: sanitizeText(alert.plate),
    type: alert.type,
    zoneName: alert.zoneName === null ? null : sanitizeText(alert.zoneName),
    startedAt: alert.startedAt,
  }));
  return { count: alerts.length, mayHaveMore: response.nextCursor !== null || response.items.length > cap, alerts };
}
