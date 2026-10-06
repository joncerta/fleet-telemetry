import { describe, expect, it } from "vitest";
import { errorLabel, pausedLabel, rejectReasonLabel } from "./labels";

describe("labels", () => {
  it("motivos conocidos y desconocidos", () => {
    expect(rejectReasonLabel("stale_timestamp")).toBe("Punto demasiado viejo");
    expect(rejectReasonLabel("motivo_nuevo")).toBe("motivo_nuevo");
  });
  it("códigos de error del motor", () => {
    expect(errorLabel(null)).toBe("Ninguno");
    expect(errorLabel("http_401")).toContain("no vinculado");
    expect(errorLabel("http_503")).toBe("Error del servidor (503)");
    expect(errorLabel("network")).toBe("Sin red");
  });
  it("pausa del sync", () => {
    expect(pausedLabel(null)).toBeNull();
    expect(pausedLabel("client_error")).toContain("400");
    expect(pausedLabel("unauthorized")).toContain("revocado");
  });
});
