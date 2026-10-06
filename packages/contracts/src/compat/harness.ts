import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/**
 * Exención explícita de la verificación hacia adelante para un contrato con uniones simples, intersecciones o `lazy`
 * que el arnés no sabe recorrer. El motivo es obligatorio y queda en el registro, visible en la revisión.
 */
export interface ForwardCompatExemption {
  readonly reason: string;
}

/** Un contrato versionado: su esquema actual y las versiones de las que existe fixture. */
export interface ContractEntry {
  readonly name: string;
  readonly schema: z.ZodType;
  readonly versions: readonly number[];
  /**
   * Solo para lo que el arnés reporta como "no verificable hacia adelante" (unión simple, intersección o `lazy` con
   * un objeto JSON). No exime de un `z.strictObject` ni de un `.catch()` que sí se pueden verificar.
   */
  readonly forwardCompatExemption?: ForwardCompatExemption;
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
 * - el esquema tenga una unión simple, una intersección o un `lazy` con un objeto JSON, que el arnés no sabe recorrer
 *   ("no verificable hacia adelante"): se modela con `z.object` o `z.discriminatedUnion`, o se registra una
 *   `forwardCompatExemption` con su motivo;
 * - el registro tenga nombres repetidos, nombres inválidos o versiones repetidas o no enteras positivas, o una
 *   exención sin motivo.
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
      const reason = await parseFixture(entry, join(fixturesDir, entry.name, `v${version}.json`), isLatest);
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
  if (entry.forwardCompatExemption !== undefined && entry.forwardCompatExemption.reason.trim() === "") {
    return "la exención de compatibilidad hacia adelante exige un motivo (forwardCompatExemption.reason)";
  }
  return undefined;
}

/** Campo que ningún esquema real define: simula lo que agregaría una versión posterior del contrato. */
export const FORWARD_COMPAT_FIELD = "__fleetForwardCompat";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Lo que el arnés no puede dar por verificado:
 * - `unverifiable`: el esquema es una unión simple, una intersección o un `lazy` y el JSON es un objeto; no se sabe
 *   en qué opción inyectar el campo extra;
 * - `swallowed`: un `.catch()` cuyo esquema interior rechaza el campo extra; `safeParse` pasaría igual, porque el
 *   `catch` sustituye el valor, y el consumer perdería en silencio los datos de un productor más nuevo.
 */
export interface ForwardFinding {
  readonly path: string;
  readonly kind: "unverifiable" | "swallowed";
  /** `def.type` de zod del esquema que lo causó (`union`, `intersection`, `lazy`, `catch`). */
  readonly schemaType: string;
}

type FindingHandler = (finding: ForwardFinding) => void;

const describeFinding = (finding: ForwardFinding): string => `${finding.schemaType} en ${finding.path || "(raíz)"}`;

/** Error de `withExtraFields` cuando no se le pasa un manejador de hallazgos: falla en cerrado. */
export class UnverifiableSchemaError extends Error {
  constructor(readonly finding: ForwardFinding) {
    super(`esquema no verificable hacia adelante: ${describeFinding(finding)}`);
    this.name = "UnverifiableSchemaError";
  }
}

const throwFinding: FindingHandler = (finding) => {
  throw new UnverifiableSchemaError(finding);
};

/**
 * Copia `json` agregando `FORWARD_COMPAT_FIELD` **siguiendo el esquema**, no la forma del JSON: solo donde el esquema
 * es un objeto, porque solo ahí un productor más nuevo puede agregar campos y un `z.strictObject` los rechazaría.
 * - `ZodObject`: agrega el campo y sigue por cada clave de `shape` (las claves que el esquema no conoce se copian tal cual);
 * - `ZodArray`: sigue por cada elemento;
 * - `ZodOptional`, `ZodNullable`, `ZodDefault`, `ZodPrefault`, `ZodReadonly` y `ZodNonOptional`: se desenvuelven (`def.innerType`);
 * - `ZodCatch`: se desenvuelve, y si el esquema interior rechaza el campo extra se entrega un hallazgo `swallowed`;
 * - `ZodPipe` (`.transform()`, `z.preprocess`, `.pipe()`, codecs): sigue por `def.out` si `def.in` es un `ZodTransform`
 *   (`z.preprocess`) y, si no, por `def.in`, que es el lado que lee el JSON;
 * - `ZodDiscriminatedUnion`: elige la opción cuyo discriminante coincide con el del JSON y sigue por ella;
 * - `ZodUnion` simple, `ZodIntersection` y `ZodLazy` con un objeto JSON: no se sabe recorrerlos y se entrega un
 *   hallazgo `unverifiable` (sin manejador, lanza `UnverifiableSchemaError`: falla en cerrado, no pasa en silencio);
 * - todo lo demás (`record`, tuplas, primitivos...) se copia sin tocar: un `z.record(z.string(), z.string())` no tiene
 *   campos "extra", sus claves son datos, y meter el campo ahí fallaría con un contrato correcto.
 * No muta el original.
 */
export function withExtraFields(schema: z.ZodType, json: unknown, onFinding: FindingHandler = throwFinding): unknown {
  return walk(schema, json, [], onFinding);
}

function walk(schema: z.ZodType, json: unknown, path: readonly string[], onFinding: FindingHandler): unknown {
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodPrefault ||
    schema instanceof z.ZodReadonly ||
    schema instanceof z.ZodNonOptional
  ) {
    return walk(schema.def.innerType as z.ZodType, json, path, onFinding);
  }
  if (schema instanceof z.ZodCatch) {
    const inner = schema.def.innerType as z.ZodType;
    const extended = walk(inner, json, path, onFinding);
    if (inner.safeParse(json).success && !inner.safeParse(extended).success) {
      onFinding({ path: path.join("."), kind: "swallowed", schemaType: "catch" });
    }
    return extended;
  }
  if (schema instanceof z.ZodPipe) {
    const { in: input, out } = schema.def;
    return walk((input instanceof z.ZodTransform ? out : input) as z.ZodType, json, path, onFinding);
  }
  if (schema instanceof z.ZodArray) {
    if (!Array.isArray(json)) return json;
    return json.map((item: unknown, index) => walk(schema.element as z.ZodType, item, [...path, String(index)], onFinding));
  }
  if (schema instanceof z.ZodDiscriminatedUnion) {
    if (!isRecord(json)) return json;
    const discriminator = schema.def.discriminator;
    const option = schema.options.find((candidate) => {
      const values = candidate._zod.propValues?.[discriminator];
      return values !== undefined && [...values].some((allowed) => allowed === json[discriminator]);
    });
    return option ? walk(option as z.ZodType, json, path, onFinding) : json;
  }
  if (schema instanceof z.ZodUnion || schema instanceof z.ZodIntersection || schema instanceof z.ZodLazy) {
    if (isRecord(json)) onFinding({ path: path.join("."), kind: "unverifiable", schemaType: schema.def.type });
    return json;
  }
  if (schema instanceof z.ZodObject) {
    if (!isRecord(json)) return json;
    const shape: Record<string, z.ZodType | undefined> = schema.shape;
    const copy: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(json)) {
      const field = shape[key];
      copy[key] = field ? walk(field, value, [...path, key], onFinding) : value;
    }
    copy[FORWARD_COMPAT_FIELD] = true;
    return copy;
  }
  return json;
}

async function parseFixture(entry: ContractEntry, path: string, checkForward: boolean): Promise<string | undefined> {
  const { schema } = entry;
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
    const findings: ForwardFinding[] = [];
    const extended = withExtraFields(schema, json, (finding) => findings.push(finding));

    const unverifiable = entry.forwardCompatExemption === undefined ? findings.filter((finding) => finding.kind === "unverifiable") : [];
    if (unverifiable.length > 0) {
      return (
        `no verificable hacia adelante: ${unverifiable.map(describeFinding).join(", ")} con un objeto; el arnés no sabe en qué opción ` +
        "inyectar un campo extra. Modela con z.object o z.discriminatedUnion, o agrega forwardCompatExemption con el motivo en el registro"
      );
    }
    const swallowed = findings.filter((finding) => finding.kind === "swallowed");
    if (swallowed.length > 0) {
      return (
        `no tolera campos extra de una versión posterior: ${swallowed.map(describeFinding).join(", ")} rechaza el campo extra y el catch lo ` +
        "reemplazaría en silencio por su valor de respaldo; usa z.object, no z.strictObject"
      );
    }

    const forward = schema.safeParse(extended);
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
