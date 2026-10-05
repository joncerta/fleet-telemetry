import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checksumOf, loadMigrationFiles, MigrationError } from "./files.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fleet-migrations-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = (name: string, sql: string) => writeFile(join(dir, name), sql);
/** Escribe el par up/down de una migración. */
const writePair = async (base: string, up: string, down = "SELECT 0;") => {
  await write(`${base}.sql`, up);
  await write(`${base}.down.sql`, down);
};

describe("loadMigrationFiles", () => {
  it("lee las migraciones ordenadas por versión, con nombre y checksum sha256", async () => {
    await writePair("010_ten", "SELECT 10;", "SELECT -10;");
    await writePair("002_two", "SELECT 2;", "SELECT -2;");
    await writePair("001_one", "SELECT 1;", "SELECT -1;");
    await write("README.md", "no es una migración");

    const files = await loadMigrationFiles(dir);

    expect(files.map((f) => [f.version, f.name, f.fileName])).toEqual([
      [1, "one", "001_one.sql"],
      [2, "two", "002_two.sql"],
      [10, "ten", "010_ten.sql"],
    ]);
    expect(files[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(files[0]?.sql).toBe("SELECT 1;");
    expect(files.map((f) => f.downFileName)).toEqual(["001_one.down.sql", "002_two.down.sql", "010_ten.down.sql"]);
    expect(files[0]?.downSql).toBe("SELECT -1;");
    expect(files[0]?.downChecksum).toBe(checksumOf("SELECT -1;"));
    expect(files[0]?.downChecksum).not.toBe(files[0]?.checksum);
  });

  it("falla si hay números de migración duplicados, nombrando los dos archivos", async () => {
    await writePair("001_a", "SELECT 1;");
    await write("001_b.sql", "SELECT 2;");

    const result = loadMigrationFiles(dir);

    await expect(result).rejects.toBeInstanceOf(MigrationError);
    await expect(result).rejects.toThrow("Número de migración duplicado 001: 001_a.sql y 001_b.sql.");
  });

  it.each([
    "1_corta.sql",
    "001-guion.sql",
    "001_Mayuscula.sql",
    "migracion.sql",
    "001_.sql",
    "001_x.down.down.sql",
    "001_X.down.sql",
    "001_x.undo.sql",
  ])(
    "falla con el archivo %s, que no sigue la convención NNN_<nombre>.sql",
    async (name) => {
      await write(name, "SELECT 1;");

      await expect(loadMigrationFiles(dir)).rejects.toThrow(/no sigue la convención/);
    },
  );

  it("falla si una migración up no tiene su down, nombrando el archivo que falta", async () => {
    await writePair("001_one", "SELECT 1;");
    await write("002_two.sql", "SELECT 2;");

    const result = loadMigrationFiles(dir);

    await expect(result).rejects.toBeInstanceOf(MigrationError);
    await expect(result).rejects.toThrow(/002_two\.sql no tiene su down: falta 002_two\.down\.sql/);
  });

  it("falla si un down no tiene su up (down huérfano)", async () => {
    await writePair("001_one", "SELECT 1;");
    await write("002_two.down.sql", "SELECT 2;");

    await expect(loadMigrationFiles(dir)).rejects.toThrow(/002_two\.down\.sql no tiene su migración up \(002_two\.sql\)/);
  });

  it("falla si el up y el down de la misma versión tienen nombres distintos", async () => {
    await write("001_one.sql", "SELECT 1;");
    await write("001_uno.down.sql", "SELECT 0;");

    await expect(loadMigrationFiles(dir)).rejects.toThrow(/001_uno\.down\.sql no coincide con el de su up 001_one\.sql/);
  });

  it("falla si hay dos downs con el mismo número", async () => {
    await writePair("001_a", "SELECT 1;");
    await write("001_b.down.sql", "SELECT 0;");

    await expect(loadMigrationFiles(dir)).rejects.toThrow("Número de migración duplicado 001: 001_a.down.sql y 001_b.down.sql.");
  });

  it("no cuenta como cambio el CRLF del down (checkout con autocrlf)", async () => {
    await writePair("001_one", "SELECT 1;", "SELECT 0;\nSELECT 1;\n");
    const lf = await loadMigrationFiles(dir);
    await write("001_one.down.sql", "SELECT 0;\r\nSELECT 1;\r\n");

    const crlf = await loadMigrationFiles(dir);

    expect(crlf[0]?.downChecksum).toBe(lf[0]?.downChecksum);
  });

  it("falla con un mensaje claro si la carpeta no existe", async () => {
    await expect(loadMigrationFiles(join(dir, "no-existe"))).rejects.toThrow(/No se pudo leer la carpeta de migraciones/);
  });

  it("devuelve una lista vacía si la carpeta no tiene migraciones", async () => {
    expect(await loadMigrationFiles(dir)).toEqual([]);
  });
});

describe("checksumOf", () => {
  it("no depende de los saltos de línea (git autocrlf en Windows)", () => {
    expect(checksumOf("SELECT 1;\r\nSELECT 2;\r\n")).toBe(checksumOf("SELECT 1;\nSELECT 2;\n"));
  });

  it("cambia con cualquier edición del contenido", () => {
    expect(checksumOf("SELECT 1;")).not.toBe(checksumOf("SELECT 1; "));
    expect(checksumOf("SELECT 1;")).not.toBe(checksumOf("SELECT 2;"));
  });

  it("es un sha256 conocido", () => {
    expect(checksumOf("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});
