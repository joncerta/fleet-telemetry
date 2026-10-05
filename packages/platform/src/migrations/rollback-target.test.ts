import { describe, expect, it } from "vitest";
import { MigrationError } from "./files.js";
import { assertRollbackTarget, parseRollbackArgs, parseRollbackCommand } from "./rollback-target.js";

describe("parseRollbackArgs", () => {
  it("sin argumentos revierte solo la última migración", () => {
    expect(parseRollbackArgs([])).toEqual({ steps: 1 });
  });

  it.each([
    [["--steps", "3"], { steps: 3 }],
    [["--steps=2"], { steps: 2 }],
    [["--to", "001"], { to: 1 }],
    [["--to=12"], { to: 12 }],
    [["--to", "0"], { to: 0 }],
  ])("interpreta %j", (argv, expected) => {
    expect(parseRollbackArgs(argv)).toEqual(expected);
  });

  it.each([
    [["--steps", "0"], /--steps debe ser un entero mayor o igual a 1/],
    [["--steps", "-1"], /--steps/],
    [["--steps", "1.5"], /--steps debe ser un entero/],
    [["--steps", "abc"], /--steps debe ser un entero/],
    [["--steps"], /argumentos de db:rollback inválidos/i],
    [["--to", "x1"], /--to debe ser un número de migración/],
    [["--to", "-2"], /--to/],
    [["--steps", "1", "--to", "1"], /no ambos/],
    [["--desconocido"], /argumentos de db:rollback inválidos/i],
    [["001"], /argumentos de db:rollback inválidos/i],
  ])("rechaza %j", (argv, message) => {
    expect(() => parseRollbackArgs(argv)).toThrow(MigrationError);
    expect(() => parseRollbackArgs(argv)).toThrow(message);
  });
});

describe("parseRollbackCommand (--dry-run)", () => {
  it("sin --dry-run, dryRun es false", () => {
    expect(parseRollbackCommand([])).toEqual({ target: { steps: 1 }, dryRun: false });
    expect(parseRollbackCommand(["--to", "1"])).toEqual({ target: { to: 1 }, dryRun: false });
  });

  it.each([
    [["--dry-run"], { steps: 1 }],
    [["--dry-run", "--steps", "2"], { steps: 2 }],
    [["--to", "0", "--dry-run"], { to: 0 }],
  ])("interpreta %j como dry run", (argv, target) => {
    expect(parseRollbackCommand(argv)).toEqual({ target, dryRun: true });
  });

  it("--dry-run no admite valor y no cambia las validaciones", () => {
    expect(() => parseRollbackCommand(["--dry-run=si"])).toThrow(/argumentos de db:rollback inválidos/i);
    expect(() => parseRollbackCommand(["--dry-run", "--steps", "0"])).toThrow(/--steps/);
    expect(() => parseRollbackCommand(["--dry-run", "--steps", "1", "--to", "1"])).toThrow(/no ambos/);
  });

  it("parseRollbackArgs devuelve solo el objetivo", () => {
    expect(parseRollbackArgs(["--dry-run", "--to", "3"])).toEqual({ to: 3 });
  });
});

describe("assertRollbackTarget", () => {
  it.each([{ steps: 1 }, { steps: 5 }, { to: 0 }, { to: 3 }])("acepta %j", (target) => {
    expect(() => assertRollbackTarget(target)).not.toThrow();
  });

  it.each([{ steps: 0 }, { steps: -1 }, { steps: 1.5 }, { steps: Number.NaN }, { to: -1 }, { to: 1.5 }])(
    "rechaza %j",
    (target) => {
      expect(() => assertRollbackTarget(target)).toThrow(MigrationError);
    },
  );
});
