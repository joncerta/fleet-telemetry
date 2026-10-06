import { createLogger, createPool, loadConfig, logConfig, type Logger } from "@fleet/platform";
import type { Pool } from "pg";
import { z } from "zod";
import { devDataConfigSchema, resolveDatabaseUrl } from "../database.js";
import { assertLocalDatabase } from "../local-only.js";

const schema = z.object({ ...devDataConfigSchema.shape, ...logConfig.shape });

/**
 * Arranque común de `db:seed` y `device:token`: valida la configuración, elige la conexión de menor privilegio,
 * aplica las guardas de base local ANTES de hacer nada y entrega el pool. Cierra el pool al terminar.
 * Un error se imprime sin stack (ConfigError, LocalOnlyError y errores de uso nombran variables y comandos, nunca
 * credenciales) y fija el código de salida.
 */
export async function runLocalCommand(command: string, action: (pool: Pool, logger: Logger) => Promise<void>): Promise<void> {
  let pool: Pool | undefined;
  try {
    const config = loadConfig(schema);
    // Los logs van a stderr: stdout queda libre para lo que el comando entrega (el token de `device:token`).
    const logger = createLogger({ service: command, level: config.LOG_LEVEL, destination: process.stderr });
    const database = resolveDatabaseUrl(config);
    pool = createPool({ connectionString: database.url, applicationName: command, logger, max: 2 });

    await assertLocalDatabase({ url: database.url, variable: database.variable, command, db: pool });
    logger.info({ variable: database.variable }, "Base local verificada");
    await action(pool, logger);
  } catch (error) {
    const message = error instanceof Error ? error.message : "error desconocido";
    process.stderr.write(`${command} falló: ${message}\n`);
    process.exitCode = 1;
  } finally {
    await pool?.end();
  }
}
