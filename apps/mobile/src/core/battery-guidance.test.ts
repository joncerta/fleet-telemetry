import { describe, expect, it } from "vitest";
import { batteryGuidance, batteryStatusOf } from "./battery-guidance";

describe("batteryStatusOf", () => {
  it("excluida, optimizada o desconocida", () => {
    expect(batteryStatusOf(true)).toBe("excluded");
    expect(batteryStatusOf(false)).toBe("optimized");
    expect(batteryStatusOf(null)).toBe("unknown");
  });
});

describe("batteryGuidance", () => {
  it.each([
    ["Xiaomi", "xiaomi"],
    ["Redmi", "xiaomi"],
    ["HUAWEI", "huawei"],
    ["samsung", "samsung"],
    ["Google", "generic"],
    [null, "generic"],
    [undefined, "generic"],
  ] as const)("%s -> %s", (manufacturer, vendor) => {
    const g = batteryGuidance(manufacturer);
    expect(g.vendor).toBe(vendor);
    expect(g.steps.length).toBeGreaterThan(0);
  });
});
