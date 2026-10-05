import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as contracts from "../index.js";
import { checkContractFixtures, findUnregisteredSchemas } from "./harness.js";
import { contractRegistry } from "./registry.js";

const fixturesDir = fileURLToPath(new URL("../../fixtures", import.meta.url));

describe("compatibilidad de contratos con sus fixtures", () => {
  it("todas las versiones registradas parsean con el esquema actual y no hay fixtures sin registrar", async () => {
    const problems = await checkContractFixtures(contractRegistry, fixturesDir);

    expect(problems).toEqual([]);
  });

  it("todo esquema zod exportado por @fleet/contracts tiene una entrada en el registro", () => {
    expect(findUnregisteredSchemas(contracts, contractRegistry)).toEqual([]);
  });
});
