import type { z } from "zod";

export type Env = Readonly<Record<string, string | undefined>>;

/**
 * Configuración inválida al arrancar (fail fast). Nombra cada variable con problema y el motivo, pero
 * **nunca** su valor: pueden ser contraseñas o URLs con credenciales (regla 15 de CLAUDE.md).
 */
export class ConfigError extends Error {
  /** Nombres de las variables con problema, ordenados. */
  readonly variables: readonly string[];

  constructor(problems: ReadonlyMap<string, string>) {
    const lines = [...problems].sort(([a], [b]) => a.localeCompare(b)).map(([name, reason]) => `  - ${name}: ${reason}`);
    super(
      "Configuración inválida. Corrige estas variables de entorno " +
        `(si faltan, compara tu .env con .env.example: puede estar desactualizado):\n${lines.join("\n")}`,
    );
    this.name = "ConfigError";
    this.variables = [...problems.keys()].sort();
  }
}

/**
 * Parsea las variables de entorno con un esquema zod y devuelve la configuración tipada.
 * Si falla, lanza `ConfigError` con todas las variables faltantes o inválidas a la vez.
 */
export function loadConfig<S extends z.ZodType>(schema: S, env: Env = process.env): z.output<S> {
  const result = schema.safeParse(env);
  if (result.success) return result.data;

  const problems = new Map<string, string>();
  for (const issue of result.error.issues) {
    // El entorno es plano: el nombre de la variable es el primer tramo del path (`KAFKA_BROKERS.0` -> `KAFKA_BROKERS`).
    const first = issue.path[0];
    const name = first === undefined ? "(configuración completa)" : String(first);
    if (problems.has(name)) continue;
    problems.set(name, describe(env[name], issue.code));
  }
  // Sin `cause`: el ZodError y el valor original no deben viajar con el error.
  throw new ConfigError(problems);
}

// El motivo se arma solo con el código del problema, nunca con el mensaje de zod ni con el valor.
function describe(value: string | undefined, code: string): string {
  if (value === undefined) return "falta";
  if (value === "") return "está vacía";
  return `valor inválido (${code})`;
}
