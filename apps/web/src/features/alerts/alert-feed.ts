import type { AlertTolerant } from "@fleet/contracts";

/**
 * Presentación de las alertas (pura). El contrato no define severidad: la web la deriva del tipo (decisión de presentación, ver el
 * resumen del cambio). Un tipo que esta versión no conoce (`unknown`, lectura tolerante) se muestra como informativo, sin inventar
 * su significado.
 */
export type AlertSeverity = "critical" | "warning" | "info";

const SEVERITY_BY_TYPE: Record<AlertTolerant["type"], AlertSeverity> = {
  critical_zone_stop: "critical",
  mocked_location: "warning",
  unknown: "info",
};
const SEVERITY_RANK: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };

export const ALERT_TYPE_LABELS: Record<AlertTolerant["type"], string> = {
  critical_zone_stop: "Detenido en zona crítica",
  mocked_location: "Ubicación simulada",
  unknown: "Alerta de un tipo no reconocido",
};

export const severityOf = (type: AlertTolerant["type"]): AlertSeverity => SEVERITY_BY_TYPE[type];

/** Ventana de una ráfaga: alertas del mismo vehículo y tipo levantadas a menos de esto una de otra se muestran juntas. */
export const BURST_WINDOW_MS = 60_000;

export interface AlertGroup {
  /** `alertId` de la más reciente del grupo: estable mientras no llegue otra. */
  readonly key: string;
  readonly vehicleId: string;
  readonly plate: string;
  readonly type: AlertTolerant["type"];
  readonly severity: AlertSeverity;
  /** Alguna del grupo sigue activa. */
  readonly active: boolean;
  /** La más reciente (por `raisedAt`). */
  readonly latest: AlertTolerant;
  readonly count: number;
}

const raisedMs = (alert: AlertTolerant): number => Date.parse(alert.raisedAt);

/**
 * Agrupa las ráfagas (mismo vehículo y tipo, levantadas a menos de `windowMs` de la anterior) y ordena: activas primero, después por
 * severidad y, a igual severidad, la más reciente primero. Diez alertas del mismo vehículo en un minuto son UNA fila con "×10".
 */
export function buildAlertFeed(alerts: Iterable<AlertTolerant>, windowMs = BURST_WINDOW_MS): AlertGroup[] {
  const byVehicleAndType = new Map<string, AlertTolerant[]>();
  for (const alert of alerts) {
    const key = `${alert.vehicleId}|${alert.type}`;
    const list = byVehicleAndType.get(key);
    if (list === undefined) byVehicleAndType.set(key, [alert]);
    else list.push(alert);
  }

  const groups: AlertGroup[] = [];
  for (const list of byVehicleAndType.values()) {
    list.sort((a, b) => raisedMs(a) - raisedMs(b));
    let burst: AlertTolerant[] = [];
    const close = () => {
      const latest = burst[burst.length - 1];
      if (latest === undefined) return;
      groups.push({
        key: latest.alertId,
        vehicleId: latest.vehicleId,
        plate: latest.plate,
        type: latest.type,
        severity: severityOf(latest.type),
        active: burst.some((alert) => alert.resolvedAt === null),
        latest,
        count: burst.length,
      });
    };
    for (const alert of list) {
      const previous = burst[burst.length - 1];
      if (previous !== undefined && raisedMs(alert) - raisedMs(previous) > windowMs) {
        close();
        burst = [];
      }
      burst.push(alert);
    }
    close();
  }

  return groups.sort(
    (a, b) =>
      Number(b.active) - Number(a.active) ||
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      raisedMs(b.latest) - raisedMs(a.latest),
  );
}

export interface Announcement {
  /** Para `aria-live="polite"`. */
  readonly polite: string | null;
  /** Para `aria-live="assertive"`: solo alertas críticas. */
  readonly assertive: string | null;
}

/**
 * Qué anunciar al lector de pantalla por las alertas ACTIVAS que no estaban en `seen`. Varias en el mismo lote se resumen en una frase
 * (nunca una lectura por alerta). Las críticas van a la región `assertive`; el resto, a la `polite`.
 */
export function announceNewAlerts(seen: ReadonlySet<string>, alerts: Iterable<AlertTolerant>): Announcement {
  const fresh = [...alerts].filter((alert) => alert.resolvedAt === null && !seen.has(alert.alertId));
  const critical = fresh.filter((alert) => severityOf(alert.type) === "critical");
  const other = fresh.filter((alert) => severityOf(alert.type) !== "critical");
  const describe = (list: AlertTolerant[], prefix: string): string | null => {
    const [first] = list;
    if (first === undefined) return null;
    if (list.length === 1) return `${prefix}: ${ALERT_TYPE_LABELS[first.type]}, ${first.plate}.`;
    const plates = [...new Set(list.map((alert) => alert.plate))];
    return `${prefix}: ${list.length} alertas nuevas (${plates.slice(0, 3).join(", ")}${plates.length > 3 ? "…" : ""}).`;
  };
  return { assertive: describe(critical, "Alerta crítica"), polite: describe(other, "Nueva alerta") };
}
