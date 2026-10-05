import { existsSync } from "node:fs";
import { dirname, join, parse } from "node:path";

/** Raíz del monorepo: la carpeta más cercana hacia arriba que tiene `pnpm-workspace.yaml`. */
export function findRepoRoot(startDir: string = process.cwd()): string | undefined {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    if (dir === parse(dir).root) return undefined;
    dir = dirname(dir);
  }
}

/**
 * Carga el `.env` de la raíz con el soporte nativo de Node (`process.loadEnvFile`), sin `dotenv`.
 * No pisa variables que ya existan en el entorno (el CI las define así). Si no hay `.env`, no hace nada.
 */
export function loadRootEnv(startDir: string = process.cwd()): void {
  const root = findRepoRoot(startDir);
  if (root === undefined) return;
  const envFile = join(root, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}
