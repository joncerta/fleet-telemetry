import * as Crypto from "expo-crypto";
import type { LocationObject } from "expo-location";
import * as TaskManager from "expo-task-manager";
import { shouldDrainFromBackground } from "../core/background-drain";
import { captureFixes } from "../core/capture";
import { toRawFix } from "../core/point";
import { logEvent } from "../infra/log";
import { getRuntime } from "../runtime";

export const LOCATION_TASK = "fleet-location-task";

/** Pocos lotes: la tarea en segundo plano tiene poco tiempo. */
const BACKGROUND_MAX_BATCHES = 5;

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

    // El punto ya está en SQLite. Enviar es "best effort" y como mucho cada 15 s (un fix cada 5 s no manda un POST por punto).
    const now = Date.now();
    const lastRaw = await runtime.store.getMeta("lastBackgroundDrainAt");
    const last = lastRaw === null ? null : Number(lastRaw);
    if (shouldDrainFromBackground(last, now)) {
      await runtime.store.setMeta("lastBackgroundDrainAt", String(now));
      await runtime.engine.drain({ maxBatches: BACKGROUND_MAX_BATCHES });
    }
  } catch (failure) {
    // Sin el mensaje del error: podría arrastrar datos del punto. Se cuenta para el diagnóstico.
    logEvent("location_task_failure", { name: failure instanceof Error ? failure.name : "unknown" });
    try {
      await (await getRuntime()).store.countTaskFailure();
    } catch {
      // Si ni la base abre no hay dónde contarlo.
    }
  }
});
