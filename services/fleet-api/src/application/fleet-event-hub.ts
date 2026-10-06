import type { Logger } from "@fleet/platform";
import type { FleetStreamEvent } from "../domain/stream-ordering.js";
import type { FleetEventSubscriptions } from "./ports.js";

/** Reparto en memoria de los eventos de la flota a los streams abiertos de ESTA réplica, agrupados por tenant. */
export interface FleetEventHub extends FleetEventSubscriptions {
  /** Entrega el evento solo a los suscriptores de `tenantId`. Un suscriptor que falla no afecta a los demás ni a quien publica. */
  readonly publish: (tenantId: string, event: FleetStreamEvent) => void;
}

/**
 * Cada réplica recibe todos los eventos de Kafka (grupo propio, regla 6) y los reparte aquí por tenant: es el aislamiento del SSE. Un
 * tenant sin suscriptores no deja rastro (su entrada se borra con el último).
 */
export function createFleetEventHub(deps: { logger: Pick<Logger, "warn"> }): FleetEventHub {
  const listenersByTenant = new Map<string, Set<(event: FleetStreamEvent) => void>>();

  return {
    subscribe(tenantId, listener) {
      const listeners = listenersByTenant.get(tenantId) ?? new Set();
      listeners.add(listener);
      listenersByTenant.set(tenantId, listeners);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && listenersByTenant.get(tenantId) === listeners) listenersByTenant.delete(tenantId);
      };
    },

    publish(tenantId, event) {
      const listeners = listenersByTenant.get(tenantId);
      if (listeners === undefined) return;
      // Copia: un listener puede cancelar su suscripción (u otra) mientras se reparte.
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch (err) {
          deps.logger.warn({ tenantId, err }, "Un suscriptor del stream falló al recibir un evento");
        }
      }
    },
  };
}
