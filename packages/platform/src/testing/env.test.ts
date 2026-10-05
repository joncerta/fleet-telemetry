import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findRepoRoot, loadRootEnv } from "./env.js";

let root: string;
let nested: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fleet-env-"));
  nested = join(root, "packages", "x");
  await mkdir(nested, { recursive: true });
  await writeFile(join(root, "pnpm-workspace.yaml"), "packages: []\n");
});

afterEach(async () => {
  delete process.env.FLEET_TEST_FROM_FILE;
  delete process.env.FLEET_TEST_ALREADY_SET;
  await rm(root, { recursive: true, force: true });
});

describe("loadRootEnv", () => {
  it("encuentra la raíz del monorepo desde un paquete", () => {
    expect(findRepoRoot(nested)).toBe(root);
  });

  it("carga el .env de la raíz sin pisar las variables que ya existen", async () => {
    await writeFile(join(root, ".env"), "FLEET_TEST_FROM_FILE=del-archivo\nFLEET_TEST_ALREADY_SET=del-archivo\n");
    process.env.FLEET_TEST_ALREADY_SET = "del-entorno";

    loadRootEnv(nested);

    expect(process.env.FLEET_TEST_FROM_FILE).toBe("del-archivo");
    expect(process.env.FLEET_TEST_ALREADY_SET).toBe("del-entorno");
  });

  it("no hace nada si no hay .env", () => {
    expect(() => loadRootEnv(nested)).not.toThrow();
    expect(process.env.FLEET_TEST_FROM_FILE).toBeUndefined();
  });
});
