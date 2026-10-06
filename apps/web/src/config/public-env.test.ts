import { describe, expect, it } from "vitest";
import { parsePublicEnv } from "./public-env";

describe("parsePublicEnv", () => {
  it("sin variables usa los valores por defecto (fleet-api y agente locales, OpenFreeMap)", () => {
    expect(parsePublicEnv({})).toEqual({
      fleetApiUrl: "http://localhost:4002",
      agentUrl: "http://localhost:4003",
      mapStyleUrl: "https://tiles.openfreemap.org/styles/positron",
    });
  });

  it("una variable vacía cuenta como ausente y se quita la barra final", () => {
    expect(
      parsePublicEnv({ NEXT_PUBLIC_FLEET_API_URL: "  ", NEXT_PUBLIC_AGENT_URL: "https://agent.example.com/", NEXT_PUBLIC_MAP_STYLE_URL: "https://tiles.example.com/style/" }),
    ).toEqual({
      fleetApiUrl: "http://localhost:4002",
      agentUrl: "https://agent.example.com",
      mapStyleUrl: "https://tiles.example.com/style",
    });
  });

  it("falla al arrancar con el nombre de la variable inválida", () => {
    expect(() => parsePublicEnv({ NEXT_PUBLIC_FLEET_API_URL: "localhost:4002" })).toThrow(/NEXT_PUBLIC_FLEET_API_URL/);
    expect(() => parsePublicEnv({ NEXT_PUBLIC_AGENT_URL: "agent" })).toThrow(/NEXT_PUBLIC_AGENT_URL/);
    expect(() => parsePublicEnv({ NEXT_PUBLIC_MAP_STYLE_URL: "ftp://tiles.example.com" })).toThrow(/NEXT_PUBLIC_MAP_STYLE_URL/);
  });
});
