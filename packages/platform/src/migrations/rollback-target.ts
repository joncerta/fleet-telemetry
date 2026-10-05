import { parseArgs } from "node:util";
import { MigrationError } from "./files.js";

/**
 * Hasta dónde revierte `db:rollback`:
 * - `steps`: las últimas N migraciones aplicadas (por defecto, 1);
 * - `to`: todas las posteriores a esa versión; la versión `to` queda aplicada. `to: 0` las revierte todas.
 */
export type RollbackTarget = { readonly steps: number } | { readonly to: number };

export const DEFAULT_ROLLBACK_TARGET: RollbackTarget = { steps: 1 };

export interface RollbackCommand {
  readonly target: RollbackTarget;
  /** Con `--dry-run` solo se calcula y se muestra el plan: no se toca la base. */
  readonly dryRun: boolean;
}

const NON_NEGATIVE_INTEGER = /^\d{1,9}$/;

/** Valida un objetivo ya construido (la API de `rollback()` no se fía de quien la llame). */
export function assertRollbackTarget(target: RollbackTarget): void {
  if ("steps" in target && "to" in target) {
    throw new MigrationError("Indica --steps o --to, no ambos.");
  }
  if ("steps" in target && !(Number.isSafeInteger(target.steps) && target.steps >= 1)) {
    throw new MigrationError("--steps debe ser un entero mayor o igual a 1.");
  }
  if ("to" in target && !(Number.isSafeInteger(target.to) && target.to >= 0)) {
    throw new MigrationError("--to debe ser un número de migración (entero mayor o igual a 0).");
  }
}

/**
 * Interpreta los argumentos de `pnpm db:rollback`: `--steps N` o `--to NNN` (sin ninguno, la última migración) y,
 * opcionalmente, `--dry-run`.
 */
export function parseRollbackCommand(argv: readonly string[]): RollbackCommand {
  let values: { steps?: string | undefined; to?: string | undefined; "dry-run"?: boolean | undefined };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: { steps: { type: "string" }, to: { type: "string" }, "dry-run": { type: "boolean" } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "argumentos inválidos";
    throw new MigrationError(`Argumentos de db:rollback inválidos: ${detail}`, { cause: error });
  }

  const dryRun = values["dry-run"] === true;
  if (values.steps !== undefined && values.to !== undefined) {
    throw new MigrationError("Indica --steps o --to, no ambos.");
  }
  if (values.steps !== undefined) {
    if (!NON_NEGATIVE_INTEGER.test(values.steps) || Number(values.steps) < 1) {
      throw new MigrationError(`--steps debe ser un entero mayor o igual a 1 (recibido "${values.steps}").`);
    }
    return { target: { steps: Number(values.steps) }, dryRun };
  }
  if (values.to !== undefined) {
    if (!NON_NEGATIVE_INTEGER.test(values.to)) {
      throw new MigrationError(`--to debe ser un número de migración, p. ej. 001 (recibido "${values.to}").`);
    }
    return { target: { to: Number(values.to) }, dryRun };
  }
  return { target: DEFAULT_ROLLBACK_TARGET, dryRun };
}

/** Igual que `parseRollbackCommand`, pero solo devuelve el objetivo. */
export const parseRollbackArgs = (argv: readonly string[]): RollbackTarget => parseRollbackCommand(argv).target;
