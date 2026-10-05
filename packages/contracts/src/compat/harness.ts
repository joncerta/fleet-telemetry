import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/** Un contrato versionado: su esquema actual y las versiones de las que existe fixture. */
export interface ContractEntry {
  readonly name: string;
  readonly schema: z.ZodType;
  readonly versions: readonly number[];
}

export interface FixtureProblem {
  readonly contract: string;
  readonly file: string;
  readonly reason: string;
}

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9-]*$/;
const FIXTURE_FILE_PATTERN = /^v([1-9]\d*)\.json$/;

/**
 * Verifica la compatibilidad hacia atrás de los contratos: todo fixture `<fixturesDir>/<name>/v<N>.json` de
 * una versión registrada debe parsear con el esquema actual.
 *
 * Devuelve la lista de problemas (vacía si todo está bien) en vez de lanzar, para que el test los muestre
 * todos juntos. Es un fallo, no un aviso, que:
 * - una versión registrada no tenga fixture, o no sea JSON, o no parsee con el esquema actual;
 * - exista un fixture o una carpeta de fixtures sin registrar (se estaría verificando menos de lo que hay);
 * - la última versión, con un campo extra en cada objeto del esquema (ver `withExtraFields`), no parsee
 *   (compatibilidad hacia adelante: un productor más nuevo puede agregar campos y un consumer con
 *   `z.strictObject` los rechazaría);
 * - el registro tenga nombres repetidos, nombres inválidos o versiones repetidas o no enteras positivas.
 */
export async function checkContractFixtures(
  entries: readonly ContractEntry[],
  fixturesDir: string,
): Promise<FixtureProblem[]> {
  const problems: FixtureProblem[] = [];
  const registered = new Map<string, ContractEntry>();

  for (const entry of entries) {
    const registryProblem = validateEntry(entry, registered);
    if (registryProblem) {
      problems.push({ contract: entry.name, file: "(registro)", reason: registryProblem });
      continue;
    }
    registered.set(entry.name, entry);
  }

  for (const entry of registered.values()) {
    for (const version of entry.versions) {
      const file = `${entry.name}/v${version}.json`;
      const isLatest = version === Math.max(...entry.versions);
      const reason = await parseFixture(entry.schema, join(fixturesDir, entry.name, `v${version}.json`), isLatest);
      if (reason) problems.push({ contract: entry.name, file, reason });
    }
  }

  problems.push(...(await findUnregistered(registered, fixturesDir)));
  return problems;
}

function validateEntry(entry: ContractEntry, seen: ReadonlyMap<string, ContractEntry>): string | undefined {
  if (!NAME_PATTERN.test(entry.name)) return "nombre inválido (letras, dígitos y guiones, empezando por letra)";
  if (seen.has(entry.name)) return "nombre repetido en el registro";
  if (entry.versions.length === 0) return "sin versiones registradas";
  if (entry.versions.some((v) => !Number.isInteger(v) || v < 1)) return "las versiones deben ser enteros positivos";
  if (new Set(entry.versions).size !== entry.versions.length) return "versiones repetidas";
  return undefined;
}

/** Campo que ningún esquema real define: simula lo que agregaría una versión posterior del contrato. */
export const FORWARD_COMPAT_FIELD = "__fleetForwardCompat";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Copia `json` agregando `FORWARD_COMPAT_FIELD` **siguiendo el esquema**, no la forma del JSON: solo donde el esquema
 * es un objeto, porque solo ahí un productor más nuevo puede agregar campos y un `z.strictObject` los rechazaría.
 * - `ZodObject`: agrega el campo y sigue por cada clave de `shape` (las claves que el esquema no conoce se copian tal cual);
 * - `ZodArray`: sigue por cada elemento;
 * - `ZodOptional` y `ZodNullable`: se desenvuelven;
 * - `ZodDiscriminatedUnion`: elige la opción cuyo discriminante coincide con el del JSON y sigue por ella;
 * - todo lo demás (`record`, uniones simples, tuplas, intersecciones, `pipe`, `lazy`...) se copia sin tocar: un
 *   `z.record(z.string(), z.string())` no tiene campos "extra", sus claves son datos, y meter el campo ahí fallaría
 *   con un contrato correcto. Lo que haya dentro de esos esquemas no se prueba hacia adelante: si hace falta, se
 *   modela con `z.object` o con `z.discriminatedUnion`.
 * No muta el original.
 */
export function withExtraFields(schema: z.ZodType, json: unknown): unknown {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    return withExtraFields(schema.unwrap() as z.ZodType, json);
  }
  if (schema instanceof z.ZodArray) {
    return Array.isArray(json) ? json.map((item: unknown) => withExtraFields(schema.element as z.ZodType, item)) : json;
  }
  if (schema instanceof z.ZodDiscriminatedUnion) {
    if (!isRecord(json)) return json;
    const discriminator = schema.def.discriminator;
    const option = schema.options.find((candidate) => {
      const values = candidate._zod.propValues?.[discriminator];
      return values !== undefined && [...values].some((allowed) => allowed === json[discriminator]);
    });
    return option ? withExtraFields(option as z.ZodType, json) : json;
  }
  if (schema instanceof z.ZodObject) {
    if (!isRecord(json)) return json;
    const shape: Record<string, z.ZodType | undefined> = schema.shape;
    const copy: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(json)) {
      const field = shape[key];
      copy[key] = field ? withExtraFields(field, value) : value;
    }
    copy[FORWARD_COMPAT_FIELD] = true;
    return copy;
  }
  return json;
}

async function parseFixture(schema: z.ZodType, path: string, checkForward: boolean): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return "falta el fixture de una versión registrada";
    throw error;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return "el fixture no es JSON válido";
  }

  const result = schema.safeParse(json);
  if (!result.success) return `ya no parsea con el esquema actual (${describeIssues(result.error)})`;

  if (checkForward) {
    const forward = schema.safeParse(withExtraFields(schema, json));
    if (!forward.success) {
      return `no tolera campos extra de una versión posterior (${describeIssues(forward.error)}); usa z.object, no z.strictObject`;
    }
  }
  return undefined;
}

const describeIssues = (error: z.ZodError): string =>
  error.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`).join("; ");

/**
 * Esquemas zod exportados que no tienen entrada en el registro (comparados por identidad). `moduleExports` es el
 * resultado de `import * as contracts`: sin esto, un esquema nuevo podría publicarse sin fixture ni verificación.
 */
export function findUnregisteredSchemas(moduleExports: Readonly<Record<string, unknown>>, entries: readonly ContractEntry[]): string[] {
  const registered = new Set<unknown>(entries.map((entry) => entry.schema));
  return Object.entries(moduleExports)
    .filter(([, value]) => value instanceof z.ZodType && !registered.has(value))
    .map(([name]) => name)
    .sort();
}

async function findUnregistered(
  registered: ReadonlyMap<string, ContractEntry>,
  fixturesDir: string,
): Promise<FixtureProblem[]> {
  const problems: FixtureProblem[] = [];
  let dirs: string[];
  try {
    const entries = await readdir(fixturesDir, { withFileTypes: true });
    dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (error) {
    if (isNotFound(error)) return problems;
    throw error;
  }

  for (const dir of dirs.sort()) {
    const entry = registered.get(dir);
    if (!entry) {
      problems.push({ contract: dir, file: `${dir}/`, reason: "carpeta de fixtures sin entrada en el registro" });
      continue;
    }
    for (const file of (await readdir(join(fixturesDir, dir))).sort()) {
      const match = FIXTURE_FILE_PATTERN.exec(file);
      if (!match) {
        problems.push({ contract: dir, file: `${dir}/${file}`, reason: "el nombre no sigue la convención v<N>.json" });
      } else if (!entry.versions.includes(Number(match[1]))) {
        problems.push({ contract: dir, file: `${dir}/${file}`, reason: "fixture de una versión no registrada" });
      }
    }
  }
  return problems;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
