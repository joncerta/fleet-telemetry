import * as Crypto from "expo-crypto";
import type { LocationObject } from "expo-location";
import * as TaskManager from "expo-task-manager";
import { captureFixes } from "../core/capture";
import type { RawFix } from "../core/point";
import { logEvent } from "../infra/log";
import { getRuntime } from "../runtime";

export const LOCATION_TASK = "fleet-location-task";

/** Un punto se encola y, de paso, se intenta drenar. Pocos lotes: la tarea en segundo plano tiene poco tiempo. */
const BACKGROUND_MAX_BATCHES = 5;

export function toRawFix(location: LocationObject): RawFix {
  const { coords } = location;
  return {
    // Hora del fix GPS, no Date.now().
    timestamp: location.timestamp,
    latitude: coords.latitude,
    longitude: coords.longitude,
    altitude: coords.altitude,
    accuracy: coords.accuracy,
    speed: coords.speed,
    heading: coords.heading,
    mocked: location.mocked,
  };
}

/**
 * `defineTask` va a NIVEL DE MÓDULO y este archivo se importa en `index.ts`, antes de registrar la app. Si estuviera
 * dentro de un componente, no existiría cuando Android despierta la app en segundo plano.
 *
 * Sin UI: no usa React, hooks, contextos ni el store de la app. Escribe en SQLite vía la cola (`getRuntime`).
 */
TaskManager.defineTask<{ locations: LocationObject[] }>(LOCATION_TASK, async ({ data, error }) => {
  if (error) {
    logEvent("location_task_error", { code: String(error.code ?? "unknown") });
    return;
  }
  const locations = data?.locations ?? [];
  if (locations.length === 0) return;

  try {
    const runtime = await getRuntime();
    const credentials = await runtime.credentials.get();
    const result = await captureFixes(locations.map(toRawFix), {
      outbox: runtime.outbox,
      vehicleId: credentials?.vehicleId ?? null,
      newEventId: () => Crypto.randomUUID(),
    });
    if (result.lastFixAt !== null) await runtime.store.setMeta("lastFixAt", String(result.lastFixAt));
    logEvent("captured", { enqueued: result.enqueued, invalid: result.invalid });

    // El punto ya está en SQLite. Enviar es un "best effort": si falla, queda pendiente.
    await runtime.engine.drain({ maxBatches: BACKGROUND_MAX_BATCHES });
  } catch (failure) {
    // Sin el mensaje del error: podría arrastrar datos del punto.
    logEvent("location_task_failure", { name: failure instanceof Error ? failure.name : "unknown" });
  }
});
