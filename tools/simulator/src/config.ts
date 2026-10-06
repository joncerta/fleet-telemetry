import { z } from "zod";

/** Mínimo por tenant: hacen falta 2 detenidos, 1 con ubicación simulada y 1 silencioso (ver `planFleet`). */
export const MIN_VEHICLES_PER_TENANT = 4;
/** Los vehículos sembrados por tenant (`VEHICLES_PER_TENANT` de `@fleet/dev-data`). */
export const MAX_VEHICLES_PER_TENANT = 15;

/**
 * Variables del simulador, todas opcionales. Los valores por defecto son los de la demo: 15 vehículos por tenant, un punto cada
 * 5 s y un lote por vehículo cada 10 a 15 s. La conexión a la base la resuelve `@fleet/dev-data` (`DATABASE_URL` o
 * `DATABASE_ADMIN_URL`) y solo se usa para emitir los tokens, contra una base local.
 */
export const simulatorConfigSchema = z
  .object({
    SIMULATOR_GATEWAY_URL: z.url({ protocol: /^https?$/ }).default("http://127.0.0.1:4001"),
    SIMULATOR_VEHICLES_PER_TENANT: z.coerce.number().int().min(MIN_VEHICLES_PER_TENANT).max(MAX_VEHICLES_PER_TENANT).default(MAX_VEHICLES_PER_TENANT),
    SIMULATOR_POINT_INTERVAL_MS: z.coerce.number().int().min(1_000).max(60_000).default(5_000),
    SIMULATOR_BATCH_MIN_MS: z.coerce.number().int().min(1_000).max(120_000).default(10_000),
    SIMULATOR_BATCH_MAX_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),
    SIMULATOR_SEED: z.coerce.number().int().min(0).max(4_294_967_295).default(1),
    SIMULATOR_DURATION_S: z.coerce.number().int().min(1).max(86_400).optional(),
    SIMULATOR_SILENT_AFTER_S: z.coerce.number().int().min(10).max(3_600).default(60),
    SIMULATOR_STATS_INTERVAL_S: z.coerce.number().int().min(5).max(600).default(30),
  })
  .refine((config) => config.SIMULATOR_BATCH_MAX_MS >= config.SIMULATOR_BATCH_MIN_MS, {
    error: "SIMULATOR_BATCH_MAX_MS debe ser mayor o igual que SIMULATOR_BATCH_MIN_MS",
    path: ["SIMULATOR_BATCH_MAX_MS"],
  });
export type SimulatorConfig = z.output<typeof simulatorConfigSchema>;
