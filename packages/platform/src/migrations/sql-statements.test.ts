import { describe, expect, it } from "vitest";
import { splitSqlStatements } from "./sql-statements.js";

describe("splitSqlStatements", () => {
  it("separa por punto y coma, sin el punto y coma, y recorta espacios", () => {
    expect(splitSqlStatements("SELECT 1;\n  SELECT 2 ;\nSELECT 3")).toEqual(["SELECT 1", "SELECT 2", "SELECT 3"]);
  });

  it("descarta lo que solo trae comentarios o espacios", () => {
    expect(splitSqlStatements("-- solo un comentario\n;\n/* otro */;\n  \nSELECT 1;\n-- final")).toEqual(["SELECT 1"]);
  });

  it("no corta en un punto y coma dentro de un comentario de línea ni de bloque (anidado)", () => {
    expect(splitSqlStatements("SELECT 1 -- a; b\n, 2; SELECT /* x; /* y; */ z; */ 3;")).toEqual([
      "SELECT 1 -- a; b\n, 2",
      "SELECT /* x; /* y; */ z; */ 3",
    ]);
  });

  it("no corta dentro de cadenas, con comilla escapada duplicada, ni de identificadores entre comillas dobles", () => {
    expect(splitSqlStatements(`SELECT 'a;b', 'it''s;ok', "col;umn"; SELECT 2;`)).toEqual([`SELECT 'a;b', 'it''s;ok', "col;umn"`, "SELECT 2"]);
  });

  it("respeta los escapes con barra de una cadena E'...' y no los de una cadena normal", () => {
    expect(splitSqlStatements(String.raw`SELECT E'a\';b'; SELECT 2;`)).toEqual([String.raw`SELECT E'a\';b'`, "SELECT 2"]);
    expect(splitSqlStatements(String.raw`SELECT 'a\'; SELECT 2;`)).toEqual([String.raw`SELECT 'a\'`, "SELECT 2"]);
  });

  it("no corta dentro de cadenas entre dólares, con o sin etiqueta (cuerpo de un DO o de una función)", () => {
    const sql = "DO $$ BEGIN PERFORM 1; PERFORM 2; END $$;\nCREATE FUNCTION f() RETURNS int AS $body$ SELECT 1; $body$ LANGUAGE sql;\nSELECT 3;";
    expect(splitSqlStatements(sql)).toEqual([
      "DO $$ BEGIN PERFORM 1; PERFORM 2; END $$",
      "CREATE FUNCTION f() RETURNS int AS $body$ SELECT 1; $body$ LANGUAGE sql",
      "SELECT 3",
    ]);
  });

  it("un parámetro posicional ($1) no abre una cadena entre dólares", () => {
    expect(splitSqlStatements("SELECT $1; SELECT $2;")).toEqual(["SELECT $1", "SELECT $2"]);
  });

  it("una sentencia sin cierre llega hasta el final", () => {
    expect(splitSqlStatements("SELECT 'sin cerrar; SELECT 2")).toEqual(["SELECT 'sin cerrar; SELECT 2"]);
  });

  it("un script vacío no tiene sentencias", () => {
    expect(splitSqlStatements("")).toEqual([]);
    expect(splitSqlStatements("  \n-- nada\n")).toEqual([]);
  });

  it("separa las sentencias de una migración de continuous aggregate real", () => {
    const sql = `-- migrate:no-transaction
CREATE MATERIALIZED VIEW IF NOT EXISTS v WITH (timescaledb.continuous) AS SELECT 1 WITH NO DATA;
CALL refresh_continuous_aggregate('v', NULL, now());
CREATE INDEX CONCURRENTLY IF NOT EXISTS i ON t (a);`;
    expect(splitSqlStatements(sql)).toHaveLength(3);
  });
});
