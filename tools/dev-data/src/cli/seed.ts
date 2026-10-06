import { runSeed } from "../seed.js";
import { runLocalCommand } from "./run.js";

// `pnpm db:seed`: datos de demo, solo en local. No es una migración: no vive en infra/db/migrations.
await runLocalCommand("db:seed", async (pool, logger) => {
  const result = await runSeed(pool);
  logger.info(result, result.tenantsInserted + result.vehiclesInserted === 0 ? "Los datos de demo ya estaban sembrados" : "Datos de demo sembrados");
});
