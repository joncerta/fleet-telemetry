import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export class MigrationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MigrationError";
  }
}

export interface MigrationFile {
  readonly version: number;
  readonly name: string;
  readonly fileName: string;
  /** sha256 hexadecimal del contenido, con saltos de línea normalizados a LF. */
  readonly checksum: string;
  readonly sql: string;
  /** Archivo `NNN_<nombre>.down.sql` que la revierte. Obligatorio: la reversibilidad es parte de la convención. */
  readonly downFileName: string;
  readonly downChecksum: string;
  readonly downSql: string;
  /**
   * `false` si el up y el down llevan `-- migrate:no-transaction` en la primera línea: el runner ejecuta cada sentencia por
   * separado, sin transacción, y registra la migración después del éxito. Ver `NO_TRANSACTION_MARKER`.
   */
  readonly transactional: boolean;
}

/**
 * Marcador de una migración sin transacción: debe ser LA PRIMERA LÍNEA del up y también la del down (el cargador falla si solo
 * uno lo lleva). Para lo que Postgres o TimescaleDB no admiten dentro de una transacción (`CREATE INDEX CONCURRENTLY`, un
 * continuous aggregate `WITH DATA`, `refresh_continuous_aggregate`).
 *
 * **Una migración así tiene que ser idempotente sentencia por sentencia** (`IF NOT EXISTS`, `IF EXISTS`, `CREATE OR REPLACE`...).
 * Sin transacción no hay reversión: si una sentencia falla, las anteriores quedan hechas y la migración NO queda registrada, así
 * que el siguiente `db:migrate` la vuelve a ejecutar desde la primera sentencia; igual el down, si falla a la mitad. Y si el
 * proceso muere entre el último efecto y el registro, ocurre lo mismo. Las sentencias se separan con
 * `splitSqlStatements`; el script no puede usar metacomandos de `psql`.
 */
export const NO_TRANSACTION_MARKER = "-- migrate:no-transaction";

/** `true` si la primera línea del script (sin BOM ni espacios sobrantes) es exactamente el marcador. */
export function hasNoTransactionMarker(sql: string): boolean {
  const firstLine = sql.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] ?? "";
  return firstLine.trim() === NO_TRANSACTION_MARKER;
}

const UP_FILE = /^(\d{3,})_([a-z0-9][a-z0-9_]*)\.sql$/;
const DOWN_FILE = /^(\d{3,})_([a-z0-9][a-z0-9_]*)\.down\.sql$/;

/**
 * El checksum se calcula sobre el contenido con `\r\n` normalizado a `\n`: git con `autocrlf` en Windows cambia
 * los saltos de línea al hacer checkout, y eso no debe contar como "editar una migración aplicada".
 */
export function checksumOf(sql: string): string {
  return createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex");
}

interface ParsedName {
  readonly version: number;
  readonly name: string;
  readonly fileName: string;
}

/**
 * Lee los pares `NNN_<nombre>.sql` (up) y `NNN_<nombre>.down.sql` (down) de la carpeta, ordenados por versión.
 * Falla, sin tocar la base de datos, si:
 * - hay un `.sql` con un nombre fuera de la convención (no se aplicaría y nadie se enteraría);
 * - hay números duplicados (entre ups o entre downs);
 * - un up no tiene down, un down no tiene up, o el up y el down de la misma versión tienen nombres distintos.
 */
export async function loadMigrationFiles(dir: string): Promise<MigrationFile[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    throw new MigrationError(`No se pudo leer la carpeta de migraciones ${dir}.`, { cause: error });
  }

  const ups = new Map<number, ParsedName>();
  const downs = new Map<number, ParsedName>();

  for (const fileName of entries.filter((entry) => entry.endsWith(".sql")).sort()) {
    const downMatch = DOWN_FILE.exec(fileName);
    const match = downMatch ?? UP_FILE.exec(fileName);
    if (!match) {
      throw new MigrationError(
        `El archivo ${fileName} no sigue la convención NNN_<nombre>.sql ni NNN_<nombre>.down.sql (minúsculas, dígitos y _).`,
      );
    }
    const target = downMatch ? downs : ups;
    const version = Number(match[1]);
    const previous = target.get(version);
    if (previous !== undefined) {
      throw new MigrationError(`Número de migración duplicado ${match[1]}: ${previous.fileName} y ${fileName}.`);
    }
    target.set(version, { version, name: match[2] ?? "", fileName });
  }

  for (const down of downs.values()) {
    if (!ups.has(down.version)) {
      throw new MigrationError(`El archivo ${down.fileName} no tiene su migración up (${pad(down.version)}_${down.name}.sql).`);
    }
  }

  const files: MigrationFile[] = [];
  for (const up of [...ups.values()].sort((a, b) => a.version - b.version)) {
    const down = downs.get(up.version);
    if (!down) {
      throw new MigrationError(
        `La migración ${up.fileName} no tiene su down: falta ${pad(up.version)}_${up.name}.down.sql. Toda migración es reversible.`,
      );
    }
    if (down.name !== up.name) {
      throw new MigrationError(`El nombre de ${down.fileName} no coincide con el de su up ${up.fileName}.`);
    }
    const sql = await readFile(join(dir, up.fileName), "utf8");
    const downSql = await readFile(join(dir, down.fileName), "utf8");
    const noTransaction = hasNoTransactionMarker(sql);
    if (noTransaction !== hasNoTransactionMarker(downSql)) {
      throw new MigrationError(
        `${up.fileName} y ${down.fileName} deben coincidir en el marcador "${NO_TRANSACTION_MARKER}" de la primera línea: ` +
          "un up sin transacción con un down transaccional (o al revés) deja una reversión que no se puede ejecutar como se escribió.",
      );
    }
    files.push({
      version: up.version,
      name: up.name,
      fileName: up.fileName,
      checksum: checksumOf(sql),
      sql,
      downFileName: down.fileName,
      downChecksum: checksumOf(downSql),
      downSql,
      transactional: !noTransaction,
    });
  }

  return files;
}

function pad(version: number): string {
  return String(version).padStart(3, "0");
}
