import { describe, expect, it } from "vitest";
import { EndpointConfigError, resolveBaseUrl } from "./endpoints";

const base = { variable: "EXPO_PUBLIC_INGEST_URL", devDefault: "http://10.0.2.2:4001" };

describe("resolveBaseUrl", () => {
  it("en desarrollo usa la variable o el valor del emulador", () => {
    expect(resolveBaseUrl({ ...base, configured: undefined, isDev: true })).toBe("http://10.0.2.2:4001");
    expect(resolveBaseUrl({ ...base, configured: "", isDev: true })).toBe("http://10.0.2.2:4001");
    expect(resolveBaseUrl({ ...base, configured: "http://192.168.1.5:4001/", isDev: true })).toBe("http://192.168.1.5:4001");
  });

  it("fuera de desarrollo falla en cerrado si falta la variable: nunca cae a 10.0.2.2", () => {
    expect(() => resolveBaseUrl({ ...base, configured: undefined, isDev: false })).toThrow(EndpointConfigError);
    expect(() => resolveBaseUrl({ ...base, configured: "  ", isDev: false })).toThrow(/falta/);
  });

  it("fuera de desarrollo exige https", () => {
    expect(() => resolveBaseUrl({ ...base, configured: "http://api.example.com", isDev: false })).toThrow(/https/);
    expect(resolveBaseUrl({ ...base, configured: "https://api.example.com/", isDev: false })).toBe("https://api.example.com");
  });
});
