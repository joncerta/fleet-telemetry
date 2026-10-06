// Tests del hook verify-affected. Corren con `pnpm test:hooks` (node:test, sin dependencias).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { affectedPackageDirs, resolveRoot, stripAnsi } from "./lib.mjs";

describe("resolveRoot", () => {
  const tops = {
    "/repo": "/repo",
    "/repo/services/processor": "/repo",
    "/repo/.claude/worktrees/agent-1": "/repo/.claude/worktrees/agent-1",
  };
  const gitTopLevel = (dir) => tops[dir];

  it("usa la raíz git del cwd del agente aunque CLAUDE_PROJECT_DIR apunte al árbol principal", () => {
    const root = resolveRoot(
      { cwd: "/repo/.claude/worktrees/agent-1", projectDir: "/repo", processCwd: "/elsewhere" },
      gitTopLevel,
    );
    assert.equal(root, "/repo/.claude/worktrees/agent-1");
  });

  it("sube a la raíz git cuando el cwd es un subdirectorio", () => {
    assert.equal(resolveRoot({ cwd: "/repo/services/processor", projectDir: "/repo", processCwd: "/x" }, gitTopLevel), "/repo");
  });

  it("cae en CLAUDE_PROJECT_DIR si el cwd no es un repo git", () => {
    assert.equal(resolveRoot({ cwd: "/tmp/nada", projectDir: "/repo", processCwd: "/x" }, gitTopLevel), "/repo");
  });

  it("sin cwd ni proyecto en git, usa el cwd del proceso y nunca un cwd que git no reconoció", () => {
    assert.equal(resolveRoot({ processCwd: "/x" }, () => undefined), "/x");
    // Un cwd con ruta de Git Bash (/c/...) no es válido para Node en Windows: no debe ganar.
    assert.equal(resolveRoot({ cwd: "/c/Users/x/repo", processCwd: "/x" }, () => undefined), "/x");
  });
});

describe("affectedPackageDirs", () => {
  it("incluye tools/ y tests/, que antes quedaban sin verificar", () => {
    const dirs = affectedPackageDirs([
      "tools/dev-data/src/seed.ts",
      "tests/e2e/harness.ts",
      "services/processor/src/main.ts",
      "packages/platform/src/index.ts",
    ]);
    assert.deepEqual(dirs.sort(), ["packages/platform", "services/processor", "tests/e2e", "tools/dev-data"]);
  });

  it("ignora archivos sueltos en la raíz de una carpeta del workspace y fuera de él", () => {
    assert.deepEqual(affectedPackageDirs(["tools/README.md", "docs/PLAN.md", "CLAUDE.md"]), []);
  });

  it("no repite un paquete con varios archivos cambiados", () => {
    assert.deepEqual(affectedPackageDirs(["apps/web/a.ts", "apps/web/b.ts"]), ["apps/web"]);
  });
});

describe("stripAnsi", () => {
  it("quita colores y estilos de la salida de vitest y turbo", () => {
    const raw = "\u001b[31m\u001b[1mAssertionError\u001b[22m: expected 1 to be 2\u001b[39m \u001b[2m(3)\u001b[22m";
    assert.equal(stripAnsi(raw), "AssertionError: expected 1 to be 2 (3)");
  });

  it("deja intacto el texto sin secuencias", () => {
    assert.equal(stripAnsi("Tests  1 failed | 9 passed (10)"), "Tests  1 failed | 9 passed (10)");
  });
});
