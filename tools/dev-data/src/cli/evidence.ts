import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger, databaseAdminConfig, defaultMigrationsDir, loadConfig, logConfig, migrate } from "@fleet/platform";
import { createTempDatabase, type TempDatabase } from "@fleet/platform/testing";
import { Client } from "pg";
import { z } from "zod";
import { loadDataset } from "../evidence/dataset.js";
import { connectLocalAdmin } from "../evidence/evidence-target.js";
import { measure } from "../evidence/measure.js";
import { parseEvidenceOptions } from "../evidence/options.js";
import { renderReport } from "../evidence/render-report.js";

// `pnpm db:evidence`: crea una base temporal con las migraciones reales, la llena con datos sintéticos, comprime, mide y escribe
// docs/evidence/persistence.md. Solo local (guardas de host y marca de `db:rollback`); la base temporal se borra siempre.
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const schema = z.object({ ...databaseAdminConfig.shape, ...logConfig.shape });

let temp: TempDatabase | undefined;
let server: Awaited<ReturnType<typeof connectLocalAdmin>> | undefined;
let work: Client | undefined;

try {
  const options = parseEvidenceOptions(process.argv.slice(2));
  const config = loadConfig(schema);
  const logger = createLogger({ service: "db-evidence", level: config.LOG_LEVEL, destination: process.stderr });
  const log = (message: string): void => logger.info(message);

  // 1. Guardas, ANTES de crear nada.
  server = await connectLocalAdmin(config.DATABASE_ADMIN_URL, async (url) => {
    const client = new Client({ connectionString: url });
    client.on("error", () => undefined);
    await client.connect();
    return client;
  });

  // 2. Base temporal con las migraciones reales.
  temp = await createTempDatabase(config.DATABASE_ADMIN_URL);
  log("base temporal creada; aplicando migraciones");
  await migrate({ adminUrl: temp.adminUrl, migrationsDir: defaultMigrationsDir, logger });

  work = new Client({ connectionString: temp.adminUrl });
  work.on("error", () => undefined);
  await work.connect();
  await work.query("SET TIME ZONE 'UTC'");

  // 3. Datos, compresión y medición. El fin del dataset se alinea a la hora: así los buckets del agregado cuadran.
  const endAt = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
  const generator = { seed: options.seed, vehicles: options.vehicles, days: options.days, intervalSeconds: options.intervalSeconds, endAt };
  const dataset = await loadDataset(work, { config: generator, zonesPerTenant: options.zonesPerTenant, log });
  const results = await measure(work, { dataset, seed: options.seed, days: options.days, intervalSeconds: options.intervalSeconds, endAt, log });

  // 4. Informe.
  const command = `pnpm db:evidence${process.argv.length > 2 ? ` ${process.argv.slice(2).join(" ")}` : ""}`;
  const target = resolve(repoRoot, options.out);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, renderReport(results, command), "utf8");
  log(`informe escrito en ${options.out}`);
} catch (error) {
  // Sin stack ni URL: los errores de configuración, guardas y medición nombran variables y opciones, nunca credenciales.
  const message = error instanceof Error ? error.message : "error desconocido";
  process.stderr.write(`db:evidence falló: ${message}\n`);
  process.exitCode = 1;
} finally {
  await work?.end().catch(() => undefined);
  // La base temporal se borra siempre, también tras un fallo.
  await temp?.drop().catch((error: unknown) => {
    process.stderr.write(`db:evidence: no se pudo borrar la base temporal ${temp?.name ?? ""}: ${error instanceof Error ? error.message : "error"}\n`);
    process.exitCode = 1;
  });
  await server?.end().catch(() => undefined);
}
