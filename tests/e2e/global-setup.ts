import { loadConfig } from "@fleet/platform";
import { assertStackAvailable } from "@fleet/platform/testing";
import type { TestProject } from "vitest/node";
import { assertBuilt, startServices } from "./harness.js";
import { e2eConfigSchema } from "./support.js";

/**
 * Antes de los tests:
 * 1. valida las variables (nombra las que falten) y que TimescaleDB y Redpanda respondan;
 * 2. exige el build de los servicios;
 * 3. levanta ingest-gateway, processor y fleet-api desde `dist/` con puerto y consumer group propios del e2e, y espera a que estén
 *    listos. Su dirección llega a los tests con `inject("gatewayUrl")`.
 *
 * La función que devuelve es el teardown: vitest la ejecuta siempre al terminar, también si un test falló.
 */
export default async function setup({ provide }: TestProject): Promise<() => Promise<void>> {
  const config = loadConfig(e2eConfigSchema);
  await assertStackAvailable({ databaseAdminUrl: config.DATABASE_ADMIN_URL, kafkaBrokers: config.KAFKA_BROKERS });
  assertBuilt();

  const services = await startServices({ kafkaBrokers: config.KAFKA_BROKERS });
  provide("runId", services.runId);
  provide("rawBacklogEnd", services.rawBacklogEnd);
  provide("gatewayUrl", services.gatewayUrl);
  provide("fleetApiUrl", services.fleetApiUrl);
  provide("processorGroup", services.processorGroup);
  provide("serviceLogDir", services.logDir);

  return () => services.stop();
}
