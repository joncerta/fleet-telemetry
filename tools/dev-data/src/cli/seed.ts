import { loadConfig } from "@fleet/platform";
import { seedConfigSchema } from "../database.js";
import { runSeed } from "../seed.js";
import { runLocalCommand } from "./run.js";

// `pnpm db:seed`: datos de demo, solo en local. No es una migración: no vive en infra/db/migrations.
await runLocalCommand("db:seed", async (pool, logger) => {
  // Fail fast: sin la contraseña no se siembra nada (ConfigError nombra la variable, nunca su valor).
  const { SEED_USER_PASSWORD } = loadConfig(seedConfigSchema);
  const result = await runSeed(pool, { userPassword: SEED_USER_PASSWORD });
  const inserted = result.tenantsInserted + result.vehiclesInserted + result.zonesInserted + result.usersInserted;
  logger.info(result, inserted === 0 ? "Los datos de demo ya estaban sembrados" : "Datos de demo sembrados");
});
