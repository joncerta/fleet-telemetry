import type { AlertTolerant } from "@fleet/contracts";
import { announceNewAlerts, type Announcement } from "./alert-feed";

export interface AlertAnnouncer {
  /**
   * Se llama con cada cambio del store. Devuelve qué anunciar, o `null` si no hay nada nuevo.
   * - Sin datos listos (`ready: false`, p. ej. tras cerrar sesión) se olvida todo.
   * - Las alertas del PRIMER estado listo (el snapshot inicial) se marcan como vistas sin anunciarlas.
   * - Después, solo las activas que no estaban se anuncian, una sola vez. En una reconexión, el snapshot nuevo y el historial de
   *   `/v1/alerts` pueden traer alertas ocurridas durante el corte: esas sí se anuncian (nuevas para el usuario), las ya vistas no.
   */
  observe(state: { ready: boolean; alerts: Readonly<Record<string, AlertTolerant>> }): Announcement | null;
}

export function createAlertAnnouncer(): AlertAnnouncer {
  let seen: Set<string> | null = null;
  let lastAlerts: unknown = null;
  return {
    observe({ ready, alerts }) {
      if (!ready) {
        seen = null;
        lastAlerts = null;
        return null;
      }
      if (alerts === lastAlerts && seen !== null) return null;
      lastAlerts = alerts;
      const list = Object.values(alerts);
      if (seen === null) {
        seen = new Set(list.map((alert) => alert.alertId));
        return null;
      }
      const next = announceNewAlerts(seen, list);
      for (const alert of list) seen.add(alert.alertId);
      return next.polite !== null || next.assertive !== null ? next : null;
    },
  };
}
