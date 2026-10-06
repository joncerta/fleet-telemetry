import { compareSeq, isNewerSeq, SSE_EVENTS, type AlertTolerant, type VehicleStateTolerant } from "@fleet/contracts";

/**
 * Orden de los eventos del stream (regla 9 y encabezado de `@fleet/contracts/fleet.ts`): un evento se aplica solo si su `seq` supera al
 * que ya se tiene de ESE vehículo (o de esa `alertId`). La comparación es por entidad y no global: `nextval` no es monótono con el
 * orden de commit entre réplicas del processor, así que un `seq` menor que el `cursor` del snapshot puede ser un evento legítimo de otra
 * entidad (ver ADR-009).
 */

/** Un cambio del read model, ya leído de Kafka (variante tolerante del contrato: un enum desconocido llega como `"unknown"`). */
export type FleetStreamEvent =
  | { readonly type: typeof SSE_EVENTS.vehicleState; readonly state: VehicleStateTolerant }
  | { readonly type: typeof SSE_EVENTS.alert; readonly alert: AlertTolerant };

/** `seq` de un evento: el que viaja en su `id:`. */
export const seqOf = (event: FleetStreamEvent): string => (event.type === SSE_EVENTS.vehicleState ? event.state.seq : event.alert.seq);

/**
 * Máximo `seq` del conjunto, o `"0"` si está vacío: el `cursor` del snapshot. Referencia ordenable contra los eventos siguientes.
 */
export function snapshotCursor(vehicles: readonly { readonly seq: string }[], alerts: readonly { readonly seq: string }[]): string {
  let cursor = "0";
  for (const { seq } of [...vehicles, ...alerts]) if (compareSeq(seq, cursor) > 0) cursor = seq;
  return cursor;
}

/** Decide qué eventos se entregan a un cliente, según el último `seq` que ya tiene de cada vehículo y de cada alerta. */
export interface SeqTracker {
  /** `true` si el evento es más nuevo que lo que el cliente ya tiene de esa entidad (y lo registra); `false` si hay que descartarlo. */
  accept(event: FleetStreamEvent): boolean;
}

export function createSeqTracker(known: {
  readonly vehicles: readonly { readonly vehicleId: string; readonly seq: string }[];
  readonly alerts: readonly { readonly alertId: string; readonly seq: string }[];
}): SeqTracker {
  const vehicleSeq = new Map(known.vehicles.map((vehicle) => [vehicle.vehicleId, vehicle.seq]));
  const alertSeq = new Map(known.alerts.map((alert) => [alert.alertId, alert.seq]));

  return {
    accept(event) {
      const [seen, id, seq] =
        event.type === SSE_EVENTS.vehicleState ? ([vehicleSeq, event.state.vehicleId, event.state.seq] as const) : ([alertSeq, event.alert.alertId, event.alert.seq] as const);
      if (!isNewerSeq(seq, seen.get(id))) return false;
      seen.set(id, seq);
      return true;
    },
  };
}
