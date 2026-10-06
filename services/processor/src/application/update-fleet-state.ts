import { alertIdName, type TelemetryRawEvent } from "@fleet/contracts";
import { advanceVehicle, selectFreshPoints, type FleetRules, type TrackedPoint } from "../domain/vehicle-state.js";
import type {
  AlertIdGenerator,
  AlertResolutionWrite,
  AlertWrite,
  Clock,
  FleetEventPublisher,
  FleetEvents,
  FleetStateTransaction,
  FleetStateUnitOfWork,
  ProcessorLogger,
  VehicleStateWrite,
} from "./ports.js";

/** Un punto ya persistido en `telemetry`, con el `correlationId` del mensaje de Kafka del que vino. */
export interface FleetTelemetry {
  readonly event: TelemetryRawEvent;
  readonly correlationId: string;
}

export interface FleetUpdateStats {
  /** Vehículos tocados por el tramo (con o sin cambio de estado). */
  readonly vehicles: number;
  /** Vehículos cuyo estado cambió y se escribió. */
  readonly statesWritten: number;
  readonly alertsRaised: number;
  readonly alertsResolved: number;
}

/** Resultado de `apply`: lo que hay que publicar y los conteos. La transacción ya está confirmada cuando existe. */
export interface FleetUpdate extends FleetEvents {
  readonly stats: FleetUpdateStats;
}

export interface FleetStateUpdater {
  /**
   * Actualiza `vehicle_state` y `alerts` con los puntos de un tramo, en UNA transacción, y devuelve lo que hay que publicar. Lanza
   * (sin tragar nada) si la base falla; entonces no queda nada escrito. No publica: eso es `publish`, después del commit.
   */
  apply(items: readonly FleetTelemetry[]): Promise<FleetUpdate>;
  /** Publica en `vehicle.state` y `fleet.alerts`. Resuelve solo con todo confirmado por el broker; rechaza si no. */
  publish(update: FleetUpdate): Promise<void>;
}

export interface UpdateFleetStateDependencies {
  readonly unitOfWork: FleetStateUnitOfWork;
  readonly publisher: FleetEventPublisher;
  readonly alertIds: AlertIdGenerator;
  readonly clock: Clock;
  readonly logger: ProcessorLogger;
  readonly rules: FleetRules;
}

const EMPTY_STATS: FleetUpdateStats = { vehicles: 0, statesWritten: 0, alertsRaised: 0, alertsResolved: 0 };

/** Junta los resultados de varios `apply` (por ejemplo, uno por vehículo cuando se aísla una fila venenosa). */
export function mergeFleetUpdates(updates: readonly FleetUpdate[]): FleetUpdate {
  return {
    vehicleStates: updates.flatMap((update) => update.vehicleStates),
    alerts: updates.flatMap((update) => update.alerts),
    stats: updates.reduce(
      (total, { stats }) => ({
        vehicles: total.vehicles + stats.vehicles,
        statesWritten: total.statesWritten + stats.statesWritten,
        alertsRaised: total.alertsRaised + stats.alertsRaised,
        alertsResolved: total.alertsResolved + stats.alertsResolved,
      }),
      EMPTY_STATS,
    ),
  };
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [item]);
    else group.push(item);
  }
  return groups;
}

const byKey = <T>([a]: readonly [string, T], [b]: readonly [string, T]): number => (a < b ? -1 : a > b ? 1 : 0);

interface Candidate {
  readonly eventId: string;
  readonly recordedAt: string;
  readonly item: FleetTelemetry;
}

/**
 * Caso de uso "actualizar el estado de los vehículos y sus alertas" (fase 1b). Lo dispara el consumer de `telemetry.raw` DESPUÉS de
 * persistir cada tramo, y se compone de dos pasos que el llamador ejecuta en orden (persistir -> `apply` -> `publish` -> offset):
 *
 * `apply`, en una sola transacción (un tramo = un `run`):
 * 1. por tenant (el del EVENTO, nunca otro; cada operación lo recibe), bloquea el estado previo y las alertas abiertas de los vehículos;
 * 2. se queda con los puntos posteriores al estado de cada vehículo (los tardíos ya están en `telemetry` pero no lo mueven) y pregunta
 *    en qué zonas cae cada uno, en una sola consulta;
 * 3. avanza cada vehículo con el dominio (estado, detención, alertas) y escribe SOLO lo que cambió, con un `seq` nuevo;
 * 4. lee lo que hay que publicar: el estado vigente de TODOS los vehículos tocados y sus alertas activas o resueltas desde el primer
 *    punto del tramo. Se lee aunque no haya cambiado nada: así una reentrega (tras un crash entre el commit y la publicación)
 *    republica lo que quedó sin publicar, y los consumidores descartan los repetidos por `seq`.
 *
 * `publish`, ya confirmada la transacción, manda los eventos con key = `vehicleId` y el `correlationId` del último mensaje de cada vehículo.
 *
 * Sin reintentos ni DLQ aquí: ambos son del orquestador (`createPersistTelemetryBatch`), que clasifica los fallos.
 */
export function createUpdateFleetState(deps: UpdateFleetStateDependencies): FleetStateUpdater {
  const { unitOfWork, publisher, alertIds, clock, logger, rules } = deps;

  async function applyTenant(tx: FleetStateTransaction, tenantId: string, tenantItems: readonly FleetTelemetry[], raisedAt: string): Promise<FleetUpdate> {
    const byVehicle = groupBy(tenantItems, ({ event }) => event.point.vehicleId);
    const vehicleIds = [...byVehicle.keys()].sort();
    // El `correlationId` del último mensaje de cada vehículo en el tramo: el que fijó el estado que se publica.
    const correlationOf = new Map(vehicleIds.map((id) => [id, byVehicle.get(id)?.at(-1)?.correlationId ?? tenantItems[0]?.correlationId ?? ""]));

    const previous = await tx.lockVehicleStates(tenantId, vehicleIds);
    const openAlerts = await tx.lockOpenAlerts(tenantId, vehicleIds);

    const fresh = new Map<string, Candidate[]>();
    for (const vehicleId of vehicleIds) {
      const candidates = (byVehicle.get(vehicleId) ?? []).map((item) => ({ eventId: item.event.point.eventId, recordedAt: item.event.point.recordedAt, item }));
      fresh.set(vehicleId, selectFreshPoints(previous.get(vehicleId), candidates));
    }
    const ordered = vehicleIds.flatMap((vehicleId) => fresh.get(vehicleId) ?? []);
    const positions = ordered.map(({ item }) => ({ lon: item.event.point.lon, lat: item.event.point.lat }));
    const zones = positions.length === 0 ? [] : await tx.zonesCovering(tenantId, positions);
    if (zones.length !== positions.length) throw new Error("La consulta de zonas devolvió un número de resultados distinto del de posiciones.");

    let cursor = 0;
    const stateWrites: VehicleStateWrite[] = [];
    const alertWrites: AlertWrite[] = [];
    const resolutions: AlertResolutionWrite[] = [];
    for (const vehicleId of vehicleIds) {
      const candidates = fresh.get(vehicleId) ?? [];
      const points: TrackedPoint[] = candidates.map(({ item }) => {
        const { point, receivedAt } = item.event;
        return {
          eventId: point.eventId,
          recordedAt: point.recordedAt,
          receivedAt,
          lon: point.lon,
          lat: point.lat,
          speedMps: point.speedMps,
          headingDeg: point.headingDeg,
          mocked: point.mocked,
          lowAccuracy: point.lowAccuracy,
          zones: zones[cursor++] ?? [],
        };
      });
      const advance = advanceVehicle({ previous: previous.get(vehicleId), points, openAlerts: openAlerts.get(vehicleId) ?? [], rules });
      if (!advance.changed) continue;
      stateWrites.push({ vehicleId, snapshot: advance.snapshot });
      for (const alert of advance.raised) {
        alertWrites.push({
          alertId: alertIds.generate(alertIdName(vehicleId, alert.type, alert.startedAt)),
          vehicleId,
          type: alert.type,
          zoneId: alert.zoneId,
          startedAt: alert.startedAt,
          raisedAt,
          resolvedAt: alert.resolvedAt,
        });
      }
      resolutions.push(...advance.resolved);
    }

    if (stateWrites.length > 0) await tx.upsertVehicleStates(tenantId, stateWrites);
    const inserted = alertWrites.length > 0 ? await tx.insertAlerts(tenantId, alertWrites) : [];
    const resolved = resolutions.length > 0 ? await tx.resolveAlerts(tenantId, resolutions) : [];

    const alertsSince = new Date(Math.min(...tenantItems.map(({ event }) => Date.parse(event.point.recordedAt)))).toISOString();
    const publishable = await tx.readPublishable(tenantId, { vehicleIds, alertsSince });

    logAlerts(tenantId, alertWrites, inserted, resolutions, resolved, correlationOf);
    const correlation = (vehicleId: string): string => correlationOf.get(vehicleId) ?? tenantItems[0]?.correlationId ?? "";
    return {
      vehicleStates: publishable.states.map((state) => ({
        key: state.vehicleId,
        correlationId: correlation(state.vehicleId),
        event: { schemaVersion: 1, tenantId, state },
      })),
      alerts: publishable.alerts.map((alert) => ({
        key: alert.vehicleId,
        correlationId: correlation(alert.vehicleId),
        event: { schemaVersion: 1, tenantId, alert },
      })),
      stats: { vehicles: vehicleIds.length, statesWritten: stateWrites.length, alertsRaised: inserted.length, alertsResolved: resolved.length },
    };
  }

  /** Solo ids, tipo y correlationId: nunca coordenadas, placa ni nombre de zona. */
  function logAlerts(
    tenantId: string,
    writes: readonly AlertWrite[],
    inserted: readonly string[],
    resolutions: readonly AlertResolutionWrite[],
    resolved: readonly string[],
    correlationOf: ReadonlyMap<string, string>,
  ): void {
    for (const write of writes.filter(({ alertId }) => inserted.includes(alertId))) {
      logger.info(
        { tenantId, vehicleId: write.vehicleId, alertId: write.alertId, type: write.type, correlationId: correlationOf.get(write.vehicleId) },
        "Alerta levantada",
      );
    }
    for (const resolution of resolutions.filter(({ alertId }) => resolved.includes(alertId))) {
      logger.info({ tenantId, alertId: resolution.alertId }, "Alerta resuelta");
    }
  }

  return {
    async apply(items) {
      if (items.length === 0) return mergeFleetUpdates([]);
      // Un solo reloj para todo el tramo: `raisedAt` es la hora del servidor al procesarlo.
      const raisedAt = clock.now().toISOString();
      const byTenant = [...groupBy(items, ({ event }) => event.tenantId)].sort(byKey);
      return unitOfWork.run(async (tx) => {
        const parts: FleetUpdate[] = [];
        // En orden de tenant y de vehículo: dos réplicas que se crucen bloquean las filas en el mismo orden.
        for (const [tenantId, tenantItems] of byTenant) parts.push(await applyTenant(tx, tenantId, tenantItems, raisedAt));
        return mergeFleetUpdates(parts);
      });
    },

    async publish(update) {
      if (update.vehicleStates.length === 0 && update.alerts.length === 0) return;
      await publisher.publish({ vehicleStates: update.vehicleStates, alerts: update.alerts });
    },
  };
}
