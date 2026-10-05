import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { checkContractFixtures, findUnregisteredSchemas, withExtraFields, type ContractEntry } from "./harness.js";

// Esquema local al test: el registro real está vacío hasta la fase 1 y el arnés no debe pasar en vacío.
const pingV1 = { id: z.uuid(), at: z.iso.datetime() };
const pingSchema = z.object(pingV1);
const pingExtended = z.object({ ...pingV1, note: z.string().optional() });

const v1Fixture = { id: "6f1c1b0e-8a0f-4b53-9b53-2a9f4a3b7c11", at: "2026-10-06T12:00:00Z" };

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fleet-fixtures-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeFixture(contract: string, file: string, content: unknown): Promise<void> {
  await mkdir(join(dir, contract), { recursive: true });
  await writeFile(join(dir, contract, file), typeof content === "string" ? content : JSON.stringify(content));
}

function entry(schema: z.ZodType, versions: number[], name = "ping"): ContractEntry {
  return { name, schema, versions };
}

describe("checkContractFixtures", () => {
  it("acepta todas las versiones registradas cuando parsean con el esquema actual", async () => {
    await writeFixture("ping", "v1.json", v1Fixture);
    await writeFixture("ping", "v2.json", { ...v1Fixture, note: "extra" });

    // El esquema actual solo agregó un campo opcional: el fixture v1 sigue siendo válido.
    const problems = await checkContractFixtures([entry(pingExtended, [1, 2])], dir);

    expect(problems).toEqual([]);
  });

  it("detecta un cambio incompatible: un fixture viejo deja de parsear", async () => {
    await writeFixture("ping", "v1.json", v1Fixture);
    const breaking = z.object({ ...pingV1, note: z.string() }); // campo nuevo obligatorio

    const problems = await checkContractFixtures([entry(breaking, [1])], dir);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ contract: "ping", file: "ping/v1.json" });
    expect(problems[0]?.reason).toContain("note");
  });

  it("falla si la última versión no tolera campos extra (consumer con strictObject)", async () => {
    await writeFixture("ping", "v1.json", v1Fixture);
    const strict = z.strictObject(pingV1);

    const problems = await checkContractFixtures([entry(strict, [1])], dir);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ contract: "ping", file: "ping/v1.json" });
    expect(problems[0]?.reason).toMatch(/no tolera campos extra.*strictObject/);
  });

  it("detecta strictObject también en objetos anidados y dentro de arreglos", async () => {
    const nested = { id: v1Fixture.id, items: [{ n: 1 }] };
    await writeFixture("ping", "v1.json", nested);
    const strictItem = z.object({ id: z.uuid(), items: z.array(z.strictObject({ n: z.number() })) });

    const problems = await checkContractFixtures([entry(strictItem, [1])], dir);

    expect(problems[0]?.reason).toMatch(/no tolera campos extra/);
  });

  it("la tolerancia a campos extra solo se exige a la última versión", async () => {
    await writeFixture("ping", "v1.json", v1Fixture);
    await writeFixture("ping", "v2.json", { ...v1Fixture, note: "x" });
    // Con v2 como última, v1 no se prueba con campos extra; el esquema pasa si la última los tolera.
    const problems = await checkContractFixtures([entry(pingExtended, [1, 2])], dir);

    expect(problems).toEqual([]);
  });

  it("falla si una versión registrada no tiene fixture", async () => {
    await writeFixture("ping", "v1.json", v1Fixture);

    const problems = await checkContractFixtures([entry(pingSchema, [1, 2])], dir);

    expect(problems).toEqual([
      { contract: "ping", file: "ping/v2.json", reason: "falta el fixture de una versión registrada" },
    ]);
  });

  it("falla si el fixture no es JSON válido", async () => {
    await writeFixture("ping", "v1.json", "{no es json");

    const problems = await checkContractFixtures([entry(pingSchema, [1])], dir);

    expect(problems[0]?.reason).toBe("el fixture no es JSON válido");
  });

  it("falla si hay un fixture de una versión no registrada o con nombre fuera de convención", async () => {
    await writeFixture("ping", "v1.json", v1Fixture);
    await writeFixture("ping", "v2.json", v1Fixture);
    await writeFixture("ping", "latest.json", v1Fixture);

    const problems = await checkContractFixtures([entry(pingSchema, [1])], dir);

    expect(problems.map((p) => [p.file, p.reason])).toEqual([
      ["ping/latest.json", "el nombre no sigue la convención v<N>.json"],
      ["ping/v2.json", "fixture de una versión no registrada"],
    ]);
  });

  it("falla si hay una carpeta de fixtures sin entrada en el registro", async () => {
    await writeFixture("huerfano", "v1.json", v1Fixture);

    const problems = await checkContractFixtures([], dir);

    expect(problems).toEqual([
      { contract: "huerfano", file: "huerfano/", reason: "carpeta de fixtures sin entrada en el registro" },
    ]);
  });

  it("tolera que la carpeta de fixtures no exista si no hay nada registrado", async () => {
    const problems = await checkContractFixtures([], join(dir, "no-existe"));

    expect(problems).toEqual([]);
  });

  it("rechaza registros mal formados", async () => {
    await writeFixture("ping", "v1.json", v1Fixture);

    const problems = await checkContractFixtures(
      [
        entry(pingSchema, [1, 1]),
        entry(pingSchema, []),
        entry(pingSchema, [0]),
        entry(pingSchema, [1], "nombre inválido"),
        entry(pingSchema, [1]),
        entry(pingSchema, [1]),
      ],
      dir,
    );

    expect(problems.map((p) => p.reason)).toEqual([
      "versiones repetidas",
      "sin versiones registradas",
      "las versiones deben ser enteros positivos",
      "nombre inválido (letras, dígitos y guiones, empezando por letra)",
      "nombre repetido en el registro",
    ]);
  });
});

describe("withExtraFields (sigue el esquema)", () => {
  it("agrega el campo extra a objetos del esquema, dentro de arreglos y de optional/nullable, sin mutar el original", () => {
    const schema = z.object({
      a: z.object({ b: z.number() }),
      list: z.array(z.object({ c: z.number() })),
      maybe: z.object({ d: z.number() }).optional(),
      nothing: z.object({ e: z.number() }).nullable(),
    });
    const original = { a: { b: 1 }, list: [{ c: 2 }], maybe: { d: 3 }, nothing: null };

    const copy = withExtraFields(schema, original);

    expect(copy).toEqual({
      a: { b: 1, __fleetForwardCompat: true },
      list: [{ c: 2, __fleetForwardCompat: true }],
      maybe: { d: 3, __fleetForwardCompat: true },
      nothing: null,
      __fleetForwardCompat: true,
    });
    expect(original).toEqual({ a: { b: 1 }, list: [{ c: 2 }], maybe: { d: 3 }, nothing: null });
  });

  it("no toca lo que en el esquema no es un objeto: record, uniones simples y arreglos de primitivos", () => {
    const schema = z.object({
      labels: z.record(z.string(), z.object({ n: z.number() })),
      either: z.union([z.object({ x: z.number() }), z.string()]),
      tags: z.array(z.string()),
    });
    const json = { labels: { a: { n: 1 } }, either: { x: 1 }, tags: ["t"] };

    expect(withExtraFields(schema, json)).toEqual({ ...json, __fleetForwardCompat: true });
  });

  it("deja pasar las claves que el esquema no conoce y los valores que no coinciden con su forma", () => {
    const schema = z.object({ list: z.array(z.object({ c: z.number() })), nested: z.object({ d: z.number() }) });

    expect(withExtraFields(schema, { list: "no es un arreglo", nested: 5, unknown: { z: 1 } })).toEqual({
      list: "no es un arreglo",
      nested: 5,
      unknown: { z: 1 },
      __fleetForwardCompat: true,
    });
  });

  describe("z.discriminatedUnion", () => {
    const event = z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("snapshot"), data: z.object({ n: z.number() }) }),
      z.object({ kind: z.literal("heartbeat") }),
    ]);

    it("inyecta en la opción cuyo discriminante coincide, a cualquier profundidad", () => {
      expect(withExtraFields(event, { kind: "snapshot", data: { n: 1 } })).toEqual({
        kind: "snapshot",
        data: { n: 1, __fleetForwardCompat: true },
        __fleetForwardCompat: true,
      });
      expect(withExtraFields(event, { kind: "heartbeat" })).toEqual({ kind: "heartbeat", __fleetForwardCompat: true });
    });

    it("sin opción que coincida copia el JSON sin tocarlo", () => {
      expect(withExtraFields(event, { kind: "otro" })).toEqual({ kind: "otro" });
      expect(withExtraFields(event, "texto")).toBe("texto");
    });
  });
});

describe("compatibilidad hacia adelante guiada por el esquema", () => {
  it("un esquema con z.record no reporta nada (las claves de un record son datos, no campos extra)", async () => {
    await writeFixture("ping", "v1.json", { id: v1Fixture.id, labels: { fleet: "bogota", zone: "norte" } });
    const withRecord = z.object({ id: z.uuid(), labels: z.record(z.string(), z.string()) });

    const problems = await checkContractFixtures([entry(withRecord, [1])], dir);

    expect(problems).toEqual([]);
  });

  it("un z.record de objetos estrictos tampoco reporta nada: no se entra en el record", async () => {
    await writeFixture("ping", "v1.json", { byId: { a: { n: 1 } } });
    const schema = z.object({ byId: z.record(z.string(), z.strictObject({ n: z.number() })) });

    expect(await checkContractFixtures([entry(schema, [1])], dir)).toEqual([]);
  });

  it("detecta un z.strictObject anidado dentro de un objeto", async () => {
    await writeFixture("ping", "v1.json", { id: v1Fixture.id, meta: { n: 1 } });
    const schema = z.object({ id: z.uuid(), meta: z.strictObject({ n: z.number() }) });

    const problems = await checkContractFixtures([entry(schema, [1])], dir);

    expect(problems).toHaveLength(1);
    expect(problems[0]?.reason).toMatch(/no tolera campos extra.*meta/);
  });

  it("detecta un z.strictObject dentro de un arreglo", async () => {
    await writeFixture("ping", "v1.json", { id: v1Fixture.id, items: [{ n: 1 }] });
    const schema = z.object({ id: z.uuid(), items: z.array(z.strictObject({ n: z.number() })) });

    const problems = await checkContractFixtures([entry(schema, [1])], dir);

    expect(problems[0]?.reason).toMatch(/no tolera campos extra.*items/);
  });

  it("detecta un z.strictObject dentro de optional y de nullable", async () => {
    await writeFixture("ping", "v1.json", { a: { n: 1 } });
    const optional = z.object({ a: z.strictObject({ n: z.number() }).optional() });
    const nullable = z.object({ a: z.strictObject({ n: z.number() }).nullable() });

    expect((await checkContractFixtures([entry(optional, [1])], dir))[0]?.reason).toMatch(/no tolera campos extra/);
    expect((await checkContractFixtures([entry(nullable, [1])], dir))[0]?.reason).toMatch(/no tolera campos extra/);
  });

  it("con z.discriminatedUnion: detecta una opción estricta y acepta las tolerantes", async () => {
    const strictEvent = z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("alert"), id: z.string() }),
      z.object({ kind: z.literal("heartbeat") }),
    ]);
    const tolerantEvent = z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("alert"), id: z.string() }),
      z.object({ kind: z.literal("heartbeat") }),
    ]);
    await writeFixture("ping", "v1.json", { kind: "alert", id: "a-1" });

    expect((await checkContractFixtures([entry(strictEvent, [1])], dir))[0]?.reason).toMatch(/no tolera campos extra/);
    expect(await checkContractFixtures([entry(tolerantEvent, [1])], dir)).toEqual([]);
  });
});

describe("findUnregisteredSchemas", () => {
  const registered = z.object({ id: z.string() });
  const forgotten = z.object({ other: z.number() });

  it("devuelve los esquemas zod exportados sin entrada en el registro, ignorando lo que no es un esquema", () => {
    const exports = { registered, forgotten, helper: () => 1, VERSION: 3, type: undefined };

    expect(findUnregisteredSchemas(exports, [entry(registered, [1], "registered")])).toEqual(["forgotten"]);
  });

  it("no devuelve nada si todos están registrados", () => {
    expect(findUnregisteredSchemas({ registered }, [entry(registered, [1], "registered")])).toEqual([]);
  });
});
