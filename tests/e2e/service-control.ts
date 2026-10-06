import { inject } from "vitest";
import "./provided-context.js";

/**
 * Pide al arnés parar o volver a levantar un servicio (ver `startControlServer` en `harness.ts`). El arnés sigue siendo el dueño del proceso:
 * el teardown global cierra también el que se haya vuelto a levantar. Resuelve cuando el servicio ya paró (proceso terminado) o ya responde
 * `GET /health` con 200 (levantado), y falla con el motivo si no.
 */
export async function controlService(name: "ingest-gateway" | "fleet-api" | "agent", action: "stop" | "start"): Promise<void> {
  const response = await fetch(`${inject("controlUrl")}/services/${name}/${action}`, {
    method: "POST",
    headers: { authorization: `Bearer ${inject("controlToken")}` },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`No se pudo ${action} ${name}: ${response.status} ${await response.text()}`);
}
