import { describe, expect, it } from "vitest";
import { formatMigrationStatus } from "./format-status.js";

const appliedAt = new Date("2026-10-04T12:00:00.000Z");

describe("formatMigrationStatus", () => {
  it("lista aplicadas y pendientes, y cierra con discrepancias: 0", () => {
    const text = formatMigrationStatus({
      applied: [{ version: 1, name: "extensions_and_roles", appliedAt, downChecksumRegistered: true }],
      pending: [{ version: 2, name: "vehicles" }],
      discrepancies: [],
    });

    expect(text).toBe(
      [
        "Aplicadas (1):",
        "  001_extensions_and_roles  2026-10-04T12:00:00.000Z",
        "Pendientes (1):",
        "  002_vehicles",
        "discrepancias: 0",
        "",
      ].join("\n"),
    );
  });

  it("avisa de un down sin registrar y lista cada discrepancia", () => {
    const text = formatMigrationStatus({
      applied: [{ version: 1, name: "one", appliedAt, downChecksumRegistered: false }],
      pending: [],
      discrepancies: ["El checksum de 001_one.sql cambió"],
    });

    expect(text).toContain("[down sin registrar: corre pnpm db:migrate]");
    expect(text).toContain("Discrepancias:\n  - El checksum de 001_one.sql cambió");
    expect(text.trimEnd().endsWith("discrepancias: 1")).toBe(true);
  });
});
