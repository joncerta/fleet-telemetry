import * as Location from "expo-location";
import { PARAMS } from "../core/params";
import { getRuntime } from "../runtime";
import { LOCATION_TASK } from "./location-task";

export async function isTracking(): Promise<boolean> {
  return Location.hasStartedLocationUpdatesAsync(LOCATION_TASK);
}

/**
 * Inicia el turno: registra la tarea de ubicación con foreground service (notificación visible mientras dure).
 * Los permisos ya deben estar concedidos (ver `permissions.ts`). Idempotente.
 */
export async function startShift(): Promise<void> {
  const runtime = await getRuntime();
  if (!(await isTracking())) {
    await Location.startLocationUpdatesAsync(LOCATION_TASK, {
      accuracy: Location.Accuracy.BestForNavigation,
      timeInterval: PARAMS.captureTimeIntervalMs,
      distanceInterval: PARAMS.captureDistanceIntervalM,
      pausesUpdatesAutomatically: false,
      foregroundService: {
        notificationTitle: "Turno activo",
        notificationBody: "Fleet Conductor está registrando tu ruta.",
        notificationColor: "#1f1e1d",
      },
    });
  }
  await runtime.store.setMeta("shiftStartedAt", String(Date.now()));
}

/** Termina el turno: el tracking nunca queda encendido "por si acaso". Lo pendiente sigue en la cola y se sigue enviando. */
export async function endShift(): Promise<void> {
  if (await isTracking()) await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  const runtime = await getRuntime();
  await runtime.store.setMeta("shiftStartedAt", null);
  // Último intento de vaciar la cola con la app abierta.
  await runtime.engine.drain({ force: true });
}
