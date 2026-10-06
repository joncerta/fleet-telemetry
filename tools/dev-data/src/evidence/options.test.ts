import { describe, expect, it } from "vitest";
import { parseEvidenceOptions } from "./options.js";
import { totalRows } from "./fleet-generator.js";

describe("parseEvidenceOptions", () => {
  it("por defecto son 300 vehículos x 14 días cada 30 s: unos 12 M de filas", () => {
    const o = parseEvidenceOptions([]);

    expect(o).toMatchObject({ vehicles: 300, days: 14, intervalSeconds: 30, zonesPerTenant: 2000 });
    expect(totalRows({ vehicles: o.vehicles, days: o.days, intervalSeconds: o.intervalSeconds })).toBe(12_096_000);
  });

  it("acepta valores propios", () => {
    expect(parseEvidenceOptions(["--vehicles", "20", "--days", "9", "--seed", "7", "--out", "x.md"])).toMatchObject({ vehicles: 20, days: 9, seed: 7, out: "x.md" });
  });

  it("rechaza valores fuera de rango o desconocidos con el nombre de la opción", () => {
    expect(() => parseEvidenceOptions(["--vehicles", "0"])).toThrow(/--vehicles/);
    expect(() => parseEvidenceOptions(["--days", "abc"])).toThrow(/--days/);
    expect(() => parseEvidenceOptions(["--nope", "1"])).toThrow();
  });
});
