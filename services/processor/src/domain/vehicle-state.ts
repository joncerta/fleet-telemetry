import type { AlertType, Movement, ZoneKind } from "@fleet/contracts";
import { haversineMeters } from "./geo-distance.js";

/**
 * Reglas del estado de un vehículo y de sus alertas (fase 1b). Puro: sin reloj, sin base de datos, sin Kafka.
 *
 * Todo se calcula con la hora del FIX GPS (`recordedAt`), nunca con la del servidor (regla 13): un lote que llega tarde o
 * desordenado da el mismo estado que si hubiera llegado a tiempo. Consecuencia: las alertas se evalúan al LLEGAR un punto, no por
 * un temporizador; un vehículo que deja de reportar no genera ni resuelve alertas (su sin señal lo deriva fleet-api al leer).
 */

/**
 * Umbrales de las reglas. Los valores por defecto son los de producto; el processor los lee de la configuración
 * (`STOP_SPEED_THRESHOLD_MPS`, `STOP_DISPLACEMENT_THRESHOLD_M`, `ALERT_CRITICAL_STOP_MINUTES`).
 */
export interface FleetRules {
  /** Un punto con velocidad MENOR que esto (m/s) está detenido. 0,5 m/s ~ 1,8 km/h: ruido de GPS con el vehículo quieto. */
  readonly stopSpeedMps: number;
  /** Sin velocidad, un punto a MENOS de esto (m) del punto previo está detenido. 15 m cubre el ruido de posición de un GPS quieto. */
  readonly stopDisplacementM: number;
  /** Minutos detenido (contra la hora del fix) en una zona crítica para levantar `critical_zone_stop`. El umbral es inclusivo. */
  readonly criticalStopMinutes: number;
}

export const DEFAULT_FLEET_RULES: FleetRules = { stopSpeedMps: 0.5, stopDisplacementM: 15, criticalStopMinutes: 20 };

/** Zona que contiene un punto: lo que el dominio necesita de ella. */
export interface ZoneRef {
  readonly zoneId: string;
  readonly kind: ZoneKind;
}

/** Lo mínimo para ordenar y filtrar puntos. */
export interface OrderedPoint {
  readonly eventId: string;
  /** ISO 8601 (con cualquier offset). */
  readonly recordedAt: string;
}

/** Un punto de telemetría ya enriquecido con las zonas que lo contienen. */
export interface TrackedPoint extends OrderedPoint {
  readonly receivedAt: string;
  readonly lon: number;
  readonly lat: number;
  readonly speedMps: number | null;
  readonly headingDeg: number | null;
  readonly mocked: boolean;
  readonly lowAccuracy: boolean;
  readonly zones: readonly ZoneRef[];
}

/** El estado de un vehículo, sin identidad ni placa (eso es de quien lo guarda). Horas en ISO 8601 UTC con milisegundos. */
export interface VehicleSnapshot {
  readonly recordedAt: string;
  readonly receivedAt: string;
  readonly lon: number;
  readonly lat: number;
  readonly speedMps: number | null;
  readonly headingDeg: number | null;
  readonly movement: Movement;
  /** Null si y solo si `movement` es `moving` (invariante del contrato y de la base). */
  readonly stoppedSince: string | null;
  readonly zoneIds: readonly string[];
  readonly mocked: boolean;
  readonly lowAccuracy: boolean;
}

/** Una alerta que sigue activa en la base. */
export interface OpenAlert {
  readonly alertId: string;
  readonly type: AlertType;
  readonly zoneId: string | null;
  readonly startedAt: string;
}

/** Una alerta que este avance levanta. Si ya se resolvió dentro del mismo avance, `resolvedAt` lo dice. El id lo calcula quien la guarda. */
export interface NewAlert {
  readonly type: AlertType;
  readonly zoneId: string | null;
  readonly startedAt: string;
  readonly resolvedAt: string | null;
}

/** Resolución de una alerta que ya estaba activa. */
export interface AlertResolution {
  readonly alertId: string;
  readonly resolvedAt: string;
}

export type VehicleAdvance =
  | { readonly changed: false }
  | {
      readonly changed: true;
      readonly snapshot: VehicleSnapshot;
      readonly raised: readonly NewAlert[];
      readonly resolved: readonly AlertResolution[];
    };

const toIso = (value: string): string => new Date(Date.parse(value)).toISOString();

function byRecordedAtThenEventId(a: OrderedPoint, b: OrderedPoint): number {
  const delta = Date.parse(a.recordedAt) - Date.parse(b.recordedAt);
  if (delta !== 0) return delta;
  return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
}

/**
 * Los puntos que pueden mover el estado: los POSTERIORES (`recordedAt` estrictamente mayor) al del estado previo, ordenados por
 * `recordedAt` (el `eventId` desempata, para que el orden no dependa del de llegada) y con un solo punto por instante. Un punto
 * tardío o repetido ya se persistió en `telemetry`, pero no hace retroceder el estado.
 */
export function selectFreshPoints<P extends OrderedPoint>(previous: { readonly recordedAt: string } | undefined, points: readonly P[]): P[] {
  let floor = previous === undefined ? Number.NEGATIVE_INFINITY : Date.parse(previous.recordedAt);
  const fresh: P[] = [];
  for (const candidate of [...points].sort(byRecordedAtThenEventId)) {
    const time = Date.parse(candidate.recordedAt);
    if (time > floor) {
      fresh.push(candidate);
      floor = time;
    }
  }
  return fresh;
}

/**
 * Detenido: velocidad menor que `stopSpeedMps` o, si el GPS no entrega velocidad, desplazamiento menor que `stopDisplacementM`
 * respecto del punto previo. Sin velocidad y sin punto previo no hay evidencia de detención: en movimiento.
 */
function isStopped(previous: VehicleSnapshot | undefined, point: TrackedPoint, rules: FleetRules): boolean {
  if (point.speedMps !== null) return point.speedMps < rules.stopSpeedMps;
  return previous !== undefined && haversineMeters(previous, point) < rules.stopDisplacementM;
}

interface WorkingAlert {
  readonly alertId: string | undefined;
  readonly type: AlertType;
  readonly zoneId: string | null;
  readonly startedAt: string;
  resolvedAt: string | null;
}

/**
 * Avanza el estado de UN vehículo con los puntos de un tramo.
 *
 * - Estado: se recorren los puntos posteriores al estado previo, en orden de `recordedAt`. `stopped` guarda en `stoppedSince` el
 *   `recordedAt` del primer punto detenido de la racha; al moverse vuelve a `moving` con `stoppedSince` null.
 * - `critical_zone_stop`: se levanta cuando el vehículo lleva detenido `criticalStopMinutes` o más (inclusivo, contra la hora del
 *   fix) y el punto está en una zona `critical` (con varias, la de menor `zoneId`). `startedAt` es `stoppedSince`. Se resuelve,
 *   con `resolvedAt` = `recordedAt` del punto, al moverse o salir de la zona de la alerta. Si reentra a la zona sin haberse
 *   movido, la alerta (mismo `startedAt`, mismo id) no se reabre: la fila resuelta se queda resuelta.
 * - `mocked_location`: se levanta con un punto `mocked`, con `startedAt` = ese punto (el primero de la racha simulada), y se
 *   resuelve con el primer punto no simulado.
 *
 * `changed: false` si ningún punto es posterior al estado previo. Lo que devuelve describe el resultado NETO: una alerta levantada y
 * resuelta dentro del mismo avance sale en `raised` ya con su `resolvedAt`.
 */
export function advanceVehicle(input: {
  readonly previous: VehicleSnapshot | undefined;
  readonly points: readonly TrackedPoint[];
  readonly openAlerts: readonly OpenAlert[];
  readonly rules: FleetRules;
}): VehicleAdvance {
  const { rules } = input;
  const fresh = selectFreshPoints(input.previous, input.points);
  if (fresh.length === 0) return { changed: false };

  const criticalStopMs = rules.criticalStopMinutes * 60_000;
  const alerts: WorkingAlert[] = input.openAlerts.map((alert) => ({
    alertId: alert.alertId,
    type: alert.type,
    zoneId: alert.zoneId,
    startedAt: toIso(alert.startedAt),
    resolvedAt: null,
  }));
  const openOf = (type: AlertType) => alerts.find((alert) => alert.type === type && alert.resolvedAt === null);

  let state = input.previous;
  for (const point of fresh) {
    const recordedAt = toIso(point.recordedAt);
    const stopped = isStopped(state, point, rules);
    const stoppedSince = stopped ? (state?.movement === "stopped" && state.stoppedSince !== null ? state.stoppedSince : recordedAt) : null;
    state = {
      recordedAt,
      receivedAt: toIso(point.receivedAt),
      lon: point.lon,
      lat: point.lat,
      speedMps: point.speedMps,
      headingDeg: point.headingDeg,
      movement: stopped ? "stopped" : "moving",
      stoppedSince,
      zoneIds: point.zones.map((zone) => zone.zoneId).sort(),
      mocked: point.mocked,
      lowAccuracy: point.lowAccuracy,
    };

    const openCritical = openOf("critical_zone_stop");
    if (openCritical !== undefined) {
      const stillThere = stopped && point.zones.some((zone) => zone.zoneId === openCritical.zoneId);
      if (!stillThere) openCritical.resolvedAt = recordedAt;
    } else if (stoppedSince !== null) {
      const criticalZoneId = point.zones
        .filter((zone) => zone.kind === "critical")
        .map((zone) => zone.zoneId)
        .sort()[0];
      const heldLongEnough = Date.parse(recordedAt) - Date.parse(stoppedSince) >= criticalStopMs;
      const alreadySeen = alerts.some((alert) => alert.type === "critical_zone_stop" && alert.startedAt === stoppedSince);
      if (criticalZoneId !== undefined && heldLongEnough && !alreadySeen) {
        alerts.push({ alertId: undefined, type: "critical_zone_stop", zoneId: criticalZoneId, startedAt: stoppedSince, resolvedAt: null });
      }
    }

    const openMocked = openOf("mocked_location");
    if (point.mocked && openMocked === undefined) {
      alerts.push({ alertId: undefined, type: "mocked_location", zoneId: null, startedAt: recordedAt, resolvedAt: null });
    } else if (!point.mocked && openMocked !== undefined) {
      openMocked.resolvedAt = recordedAt;
    }
  }

  if (state === undefined) return { changed: false };
  return {
    changed: true,
    snapshot: state,
    raised: alerts
      .filter((alert) => alert.alertId === undefined)
      .map(({ type, zoneId, startedAt, resolvedAt }) => ({ type, zoneId, startedAt, resolvedAt })),
    resolved: alerts.flatMap((alert) => (alert.alertId !== undefined && alert.resolvedAt !== null ? [{ alertId: alert.alertId, resolvedAt: alert.resolvedAt }] : [])),
  };
}
