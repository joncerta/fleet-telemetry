import type { Alert, AlertsQuery } from "@fleet/contracts";
import type { AlertCursor, AlertReader } from "./ports.js";

export interface ListAlertsInput extends Omit<AlertsQuery, "cursor"> {
  tenantId: string;
  /** Posición ya decodificada del cursor opaco (la decodifica la entrada HTTP); sin ella, la primera página. */
  after?: AlertCursor | undefined;
}

export interface ListAlertsResult {
  items: Alert[];
  /** Posición después de la cual sigue la página siguiente, o `null` si no hay más. */
  next: AlertCursor | null;
}

export type ListAlerts = (input: ListAlertsInput) => Promise<ListAlertsResult>;

/**
 * Alertas del tenant, de la más reciente a la más antigua, paginadas por keyset `(raised_at DESC, alert_id DESC)`. Pide una más
 * que `limit` para saber si hay otra página sin un `COUNT`; esa extra no se devuelve.
 */
export function createListAlerts(deps: { reader: AlertReader }): ListAlerts {
  return async ({ tenantId, status, limit, after }) => {
    const records = await deps.reader.findAlerts({ tenantId, status, after, limit: limit + 1 });
    const page = records.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((record) => record.alert),
      next: records.length > limit && last !== undefined ? last.cursor : null,
    };
  };
}
