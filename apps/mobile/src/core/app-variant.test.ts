import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const { resolveVariant, allowsCleartext } = createRequire(import.meta.url)("../../config/variant.cjs") as {
  resolveVariant: (raw: string | undefined) => string;
  allowsCleartext: (variant: string) => boolean;
};

describe("variante del build (HTTP en claro)", () => {
  it("sin APP_VARIANT es producción y no permite HTTP en claro", () => {
    for (const raw of [undefined, "", "  "]) {
      const variant = resolveVariant(raw);
      expect(variant).toBe("production");
      expect(allowsCleartext(variant)).toBe(false);
    }
  });
  it("solo development lo permite", () => {
    expect(allowsCleartext(resolveVariant("development"))).toBe(true);
    expect(allowsCleartext(resolveVariant("preview"))).toBe(false);
    expect(allowsCleartext(resolveVariant("production"))).toBe(false);
    expect(allowsCleartext(resolveVariant("Development"))).toBe(false);
  });
});
