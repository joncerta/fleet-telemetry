import { randomUUID } from "node:crypto";
import { devDataConfigSchema, resolveDatabaseUrl, SEED_ZONES, seedVehicles, SEED_TENANTS } from "@fleet/dev-data";
import { createLogger, createPool, loadConfig, logConfig, type Logger } from "@fleet/platform";
import { z } from "zod";
import { citiesOfSeedTenants } from "./cities.js";
import { simulatorConfigSchema } from "./config.js";
import { createRng } from "./rng.js";
import { runVehicle } from "./runner.js";
import { createSender } from "./sender.js";
import { createStatsCollector, type StatsCollector } from "./stats.js";
import { acquireDeviceTokens } from "./tokens.js";
import { createVehicleOutbox } from "./vehicle-outbox.js";
import { createVehicleSimulator, planFleet } from "./vehicle-simulator.js";

// Único composition root del simulador: `pnpm simulate`. Solo local (tokens de dispositivo de la base de desarrollo).
// Logs: únicamente conteos por tenant (regla 14). Nunca coordenadas, placas ni tokens.
const SERVICE = "simulate";
const ACK_TIMEOUT_MS = 8_000;

function logSummaries(logger: Logger, stats: StatsCollector, message: string): void {
  for (const summary of stats.summaries()) {
    logger.info(
      {
        tenantId: summary.tenantId,
        sent: summary.sent,
        accepted: summary.accepted,
        rejected: summary.rejected,
        failedBatches: summary.failedBatches,
        dropped: summary.dropped,
        ackLatencyAvgMs: summary.ackLatencyAvgMs,
        ackLatencyMaxMs: summary.ackLatencyMaxMs,
      },
      message,
    );
  }
}

async function main(): Promise<void> {
  const config = loadConfig(z.object({ ...devDataConfigSchema.shape, ...logConfig.shape }).and(simulatorConfigSchema));
  const logger = createLogger({ service: SERVICE, level: config.LOG_LEVEL });

  const vehicles = seedVehicles(SEED_TENANTS, config.SIMULATOR_VEHICLES_PER_TENANT);

  // Los tokens salen de la base local (con las guardas de `@fleet/dev-data`) y viven solo en memoria.
  const database = resolveDatabaseUrl(config);
  const pool = createPool({ connectionString: database.url, applicationName: SERVICE, logger, max: 2 });
  let tokens: ReadonlyMap<string, string>;
  try {
    tokens = await acquireDeviceTokens({ pool, databaseUrl: database.url, variable: database.variable, vehicles });
  } finally {
    await pool.end();
  }

  const cities = citiesOfSeedTenants();
  const stats = createStatsCollector();
  const sender = createSender({ gatewayUrl: config.SIMULATOR_GATEWAY_URL, fetch: (url, init) => fetch(url, init), nowMs: () => performance.now(), timeoutMs: ACK_TIMEOUT_MS });
  const rng = createRng(config.SIMULATOR_SEED);
  const startedAt = new Date();
  const controller = new AbortController();

  const runs = planFleet(vehicles, SEED_ZONES).map((plan) => {
    const city = cities.find((candidate) => candidate.tenantId === plan.vehicle.tenantId);
    const token = tokens.get(plan.vehicle.id);
    if (city === undefined || token === undefined) throw new Error("Falta la ciudad o el token de un vehículo del simulador.");
    const vehicleRng = rng.fork(plan.vehicle.id);
    return runVehicle({
      simulator: createVehicleSimulator({ plan, city, rng: vehicleRng, startedAt, silentAfterMs: config.SIMULATOR_SILENT_AFTER_S * 1_000, newEventId: randomUUID }),
      outbox: createVehicleOutbox({ tenantId: plan.vehicle.tenantId, token, sender, stats, now: () => new Date() }),
      rng: vehicleRng,
      now: () => new Date(),
      pointIntervalMs: config.SIMULATOR_POINT_INTERVAL_MS,
      batchMinMs: config.SIMULATOR_BATCH_MIN_MS,
      batchMaxMs: config.SIMULATOR_BATCH_MAX_MS,
      signal: controller.signal,
    });
  });

  // Apagado ordenado: se detienen los bucles, se espera el envío en vuelo de cada vehículo y se escribe el resumen final.
  const stop = (reason: string): void => {
    if (controller.signal.aborted) return;
    logger.info({ reason }, "Apagando el simulador");
    controller.abort();
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
  const statsTimer = setInterval(() => logSummaries(logger, stats, "Resumen del simulador"), config.SIMULATOR_STATS_INTERVAL_S * 1_000);
  const durationTimer = config.SIMULATOR_DURATION_S === undefined ? undefined : setTimeout(() => stop("duración cumplida"), config.SIMULATOR_DURATION_S * 1_000);

  logger.info(
    { vehicles: vehicles.length, gateway: new URL(config.SIMULATOR_GATEWAY_URL).origin, seed: config.SIMULATOR_SEED, durationS: config.SIMULATOR_DURATION_S ?? null },
    "Simulador en marcha (Ctrl+C para detenerlo)",
  );

  await Promise.all(runs);
  clearInterval(statsTimer);
  if (durationTimer !== undefined) clearTimeout(durationTimer);
  logSummaries(logger, stats, "Resumen final del simulador");
}

try {
  await main();
} catch (error) {
  // Sin stack: los errores de configuración y de guarda nombran variables y comandos, nunca credenciales ni valores.
  process.stderr.write(`simulate falló: ${error instanceof Error ? error.message : "error desconocido"}\n`);
  process.exitCode = 1;
}
