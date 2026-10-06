import { describe, expect, it } from "vitest";
import { resolveDatabaseUrl } from "./database.js";

const app = "postgres://fleet_app:x@127.0.0.1:5432/fleet";
const admin = "postgres://fleet:y@127.0.0.1:5432/fleet";

describe("resolveDatabaseUrl", () => {
  it("prefiere DATABASE_URL (fleet_app, menor privilegio) aunque exista la de administración", () => {
    expect(resolveDatabaseUrl({ DATABASE_URL: app, DATABASE_ADMIN_URL: admin })).toEqual({ url: app, variable: "DATABASE_URL" });
  });

  it("usa DATABASE_ADMIN_URL solo si no hay DATABASE_URL", () => {
    expect(resolveDatabaseUrl({ DATABASE_ADMIN_URL: admin })).toEqual({ url: admin, variable: "DATABASE_ADMIN_URL" });
  });

  it("falla nombrando las dos variables si no hay ninguna, sin valores", () => {
    expect(() => resolveDatabaseUrl({})).toThrow(/DATABASE_URL.*DATABASE_ADMIN_URL/);
  });
});
