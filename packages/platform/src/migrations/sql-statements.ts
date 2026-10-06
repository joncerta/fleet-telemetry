/**
 * Divide un script SQL en sentencias, para las migraciones sin transacción (`-- migrate:no-transaction`).
 *
 * Hace falta porque un `client.query(script)` con varias sentencias es UNA sola transacción implícita en el protocolo simple de
 * Postgres: `CREATE INDEX CONCURRENTLY` o `CALL refresh_continuous_aggregate(...)` fallan ahí con "cannot run inside a transaction
 * block" o "cannot be executed within a multi-command string". Cada sentencia debe viajar sola.
 *
 * Reconoce lo que puede contener un `;` sin terminar la sentencia: comentarios de línea (`--`) y de bloque (anidables como en
 * Postgres), cadenas `'...'` (con `''` y, tras `E`, escapes con `\`), identificadores `"..."` y cadenas entre dólares
 * (`$$...$$` y `$etiqueta$...$etiqueta$`, p. ej. el cuerpo de un `DO`). No interpreta `psql` (`\c`, `\set`...). Asume
 * `standard_conforming_strings = on`, el valor por defecto. Devuelve las sentencias sin el `;` final y sin las que solo traen
 * comentarios o espacios.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let hasCode = false;
  let i = 0;

  const flush = (): void => {
    if (hasCode) statements.push(current.trim());
    current = "";
    hasCode = false;
  };

  while (i < sql.length) {
    const char = sql.charAt(i);
    const next = sql.charAt(i + 1);

    if (char === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end;
      current += sql.slice(i, stop);
      i = stop;
    } else if (char === "/" && next === "*") {
      const stop = endOfBlockComment(sql, i);
      current += sql.slice(i, stop);
      i = stop;
    } else if (char === "'") {
      const escapes = /[eE]/.test(sql.charAt(i - 1)) && !isIdentifierChar(sql.charAt(i - 2));
      const stop = endOfQuoted(sql, i, "'", escapes);
      current += sql.slice(i, stop);
      hasCode = true;
      i = stop;
    } else if (char === '"') {
      const stop = endOfQuoted(sql, i, '"', false);
      current += sql.slice(i, stop);
      hasCode = true;
      i = stop;
    } else if (char === "$" && !isIdentifierChar(sql.charAt(i - 1))) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))?.[0];
      if (tag === undefined) {
        current += char;
        hasCode = true;
        i += 1;
      } else {
        const close = sql.indexOf(tag, i + tag.length);
        const stop = close === -1 ? sql.length : close + tag.length;
        current += sql.slice(i, stop);
        hasCode = true;
        i = stop;
      }
    } else if (char === ";") {
      flush();
      i += 1;
    } else {
      current += char;
      if (!/\s/.test(char)) hasCode = true;
      i += 1;
    }
  }
  flush();
  return statements;
}

const isIdentifierChar = (char: string): boolean => /[A-Za-z0-9_$]/.test(char);

/** Índice justo después del comentario de bloque que empieza en `start` (anidados). Sin cierre, hasta el final. */
function endOfBlockComment(sql: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < sql.length) {
    if (sql.startsWith("/*", i)) {
      depth += 1;
      i += 2;
    } else if (sql.startsWith("*/", i)) {
      depth -= 1;
      i += 2;
      if (depth === 0) return i;
    } else {
      i += 1;
    }
  }
  return sql.length;
}

/** Índice justo después de la cadena o el identificador entre comillas que empieza en `start`. Sin cierre, hasta el final. */
function endOfQuoted(sql: string, start: number, quote: string, backslashEscapes: boolean): number {
  let i = start + 1;
  while (i < sql.length) {
    const char = sql.charAt(i);
    if (backslashEscapes && char === "\\") {
      i += 2;
    } else if (char === quote) {
      if (sql.charAt(i + 1) === quote) i += 2;
      else return i + 1;
    } else {
      i += 1;
    }
  }
  return sql.length;
}
