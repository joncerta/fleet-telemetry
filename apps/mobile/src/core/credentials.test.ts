import { describe, expect, it } from "vitest";
import { parseCredentialsInput } from "./credentials";

const TOKEN = `fdt_${"A".repeat(43)}`;
const VEHICLE = "11111111-1111-4111-8111-111111111111";

describe("parseCredentialsInput", () => {
  it("acepta token y vehículo válidos, con espacios y mayúsculas", () => {
    const r = parseCredentialsInput(` ${TOKEN}\n`, ` ${VEHICLE.toUpperCase()} `);
    expect(r).toEqual({ ok: true, credentials: { token: TOKEN, vehicleId: VEHICLE } });
  });
  it("rechaza un token mal formado sin eco del valor", () => {
    expect(parseCredentialsInput("no-es-un-token", VEHICLE)).toEqual({ ok: false, error: "token_format" });
  });
  it("rechaza un vehículo que no es UUID", () => {
    expect(parseCredentialsInput(TOKEN, "NRT101")).toEqual({ ok: false, error: "vehicle_format" });
  });
});
