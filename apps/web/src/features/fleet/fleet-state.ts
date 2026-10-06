import { compareSeq, isNewerSeq, type AlertTolerant, type SseSnapshotTolerant, type VehicleStateTolerant } from "@fleet/contracts";

/**
 * Estado en vivo de la flota y sus reducers PUROS (sin React, sin red): son la regla de aplicación del contrato y se prueban solos.
 *
 * - El snapshot REEMPLAZA vehículos y alertas: nunca se mezcla con lo anterior (lo anterior puede ser de otra conexión).
 * - Un evento de vehículo se aplica solo si su `seq` supera al que ya se tiene de ESE vehículo (`isNewerSeq`); un evento de alerta, al
 *   de ESA `alertId`. Los repetidos y los viejos se descartan.
 * - Sin cambios, los reducers devuelven la MISMA referencia: el store no notifica y React no vuelve a renderizar.
 */

/** Alertas resueltas que se conservan para el historial del panel (las activas se conservan todas). */
export const MAX_RESOLVED_ALERTS = 100;

export interface FleetData {
  /** Último estado por `vehicleId`: un objeto indexado, nunca un array que se copia entero con cada evento. */
  readonly vehicles: Readonly<Record<string, VehicleStateTolerant>>;
  /** Alertas por `alertId`: las activas del snapshot más las que llegan en vivo o por `/v1/alerts`. */
  readonly alerts: Readonly<Record<string, AlertTolerant>>;
  /** `cursor` del último snapshot (máximo `seq` incluido). `null` hasta el primero. */
  readonly cursor: string | null;
  /** `true` desde que llegó el primer snapshot: antes de eso no hay datos que mostrar. */
  readonly ready: boolean;
}

export type FleetStreamEvent = { readonly type: "vehicle.state"; readonly state: VehicleStateTolerant } | { readonly type: "alert"; readonly alert: AlertTolerant };

export const EMPTY_FLEET: FleetData = { vehicles: {}, alerts: {}, cursor: null, ready: false };

function putIfNewer<T extends { seq: string }>(target: Record<string, T>, key: string, value: T): boolean {
  if (!isNewerSeq(value.seq, target[key]?.seq)) return false;
  target[key] = value;
  return true;
}

/** Recorta las resueltas más viejas (por `seq`) por encima de `MAX_RESOLVED_ALERTS`. Las activas nunca se recortan. */
function pruneResolved(alerts: Record<string, AlertTolerant>): Record<string, AlertTolerant> {
  const resolved = Object.values(alerts).filter((alert) => alert.resolvedAt !== null);
  if (resolved.length <= MAX_RESOLVED_ALERTS) return alerts;
  resolved.sort((a, b) => compareSeq(b.seq, a.seq));
  const pruned = { ...alerts };
  for (const old of resolved.slice(MAX_RESOLVED_ALERTS)) delete pruned[old.alertId];
  return pruned;
}

/** El snapshot reemplaza el estado. Si trae un vehículo o una alerta repetidos, se queda el de mayor `seq`. */
export function replaceWithSnapshot(snapshot: SseSnapshotTolerant): FleetData {
  const vehicles: Record<string, VehicleStateTolerant> = {};
  for (const state of snapshot.vehicles) putIfNewer(vehicles, state.vehicleId, state);
  const alerts: Record<string, AlertTolerant> = {};
  for (const alert of snapshot.alerts) putIfNewer(alerts, alert.alertId, alert);
  return { vehicles, alerts, cursor: snapshot.cursor, ready: true };
}

/**
 * Aplica un lote de eventos en orden. Copia cada mapa una sola vez por lote (no por evento). Un tipo que esta versión no conoce se
 * ignora. Antes del primer snapshot no se aplica nada: el snapshot es la base y reemplazaría lo aplicado.
 */
export function applyEvents(data: FleetData, events: readonly FleetStreamEvent[]): FleetData {
  if (!data.ready || events.length === 0) return data;
  let vehicles: Record<string, VehicleStateTolerant> | null = null;
  let alerts: Record<string, AlertTolerant> | null = null;

  for (const event of events) {
    switch (event.type) {
      case "vehicle.state": {
        if (!isNewerSeq(event.state.seq, (vehicles ?? data.vehicles)[event.state.vehicleId]?.seq)) break;
        vehicles ??= { ...data.vehicles };
        vehicles[event.state.vehicleId] = event.state;
        break;
      }
      case "alert": {
        if (!isNewerSeq(event.alert.seq, (alerts ?? data.alerts)[event.alert.alertId]?.seq)) break;
        alerts ??= { ...data.alerts };
        alerts[event.alert.alertId] = event.alert;
        break;
      }
      default:
        break;
    }
  }

  if (vehicles === null && alerts === null) return data;
  return { ...data, vehicles: vehicles ?? data.vehicles, alerts: alerts === null ? data.alerts : pruneResolved(alerts) };
}

/** Mezcla alertas leídas de `/v1/alerts` (las ocurridas durante una desconexión) con la misma regla de `seq` por `alertId`. */
export function mergeAlerts(data: FleetData, incoming: readonly AlertTolerant[]): FleetData {
  return applyEvents(
    data,
    incoming.map((alert) => ({ type: "alert", alert }) as const),
  );
}
