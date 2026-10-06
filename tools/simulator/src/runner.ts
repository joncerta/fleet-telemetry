import type { TelemetryPoint } from "@fleet/contracts";
import type { Rng } from "./rng.js";
import type { VehicleOutbox } from "./vehicle-outbox.js";
import type { VehicleSimulator } from "./vehicle-simulator.js";

/** Espera `ms` o hasta que `signal` se aborte (lo que ocurra primero). Nunca rechaza. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

export interface VehicleRunnerOptions {
  simulator: VehicleSimulator;
  outbox: VehicleOutbox;
  rng: Rng;
  now: () => Date;
  pointIntervalMs: number;
  batchMinMs: number;
  batchMaxMs: number;
  signal: AbortSignal;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Bucle de un vehículo: genera los puntos que "capturó" cada `pointIntervalMs` (con `recordedAt` del momento del fix) y los envía
 * en un lote cada `batchMinMs` a `batchMaxMs` (al azar, para que los vehículos no se sincronicen). Un vehículo con historial
 * (la parada en zona crítica) lo envía primero. Termina cuando `signal` se aborta, tras terminar el envío en vuelo.
 */
export async function runVehicle(options: VehicleRunnerOptions): Promise<void> {
  const { simulator, outbox, rng, now, pointIntervalMs, signal } = options;
  const wait = options.sleep ?? sleep;

  outbox.enqueue(simulator.history(now()));
  await outbox.flush();

  let nextPointAtMs = now().getTime() + pointIntervalMs;
  while (!signal.aborted) {
    await wait(rng.range(options.batchMinMs, options.batchMaxMs), signal);
    if (signal.aborted) break;
    const nowMs = now().getTime();
    const due: TelemetryPoint[] = [];
    for (; nextPointAtMs <= nowMs; nextPointAtMs += pointIntervalMs) {
      const point = simulator.point(new Date(nextPointAtMs));
      if (point !== null) due.push(point);
    }
    outbox.enqueue(due);
    await outbox.flush();
  }
}
