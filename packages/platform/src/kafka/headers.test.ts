import { describe, expect, it } from "vitest";
import {
  CORRELATION_ID_HEADER,
  CorrelationIdError,
  getCorrelationId,
  isValidCorrelationId,
  resolveCorrelationId,
  withCorrelationId,
} from "./headers.js";

describe("headers de correlación", () => {
  it("usa el header `correlationId`", () => {
    expect(CORRELATION_ID_HEADER).toBe("correlationId");
  });

  it("withCorrelationId agrega el header sin perder los demás ni mutar el original", () => {
    const original = { source: "gateway" };

    const headers = withCorrelationId(original, "c-1");

    expect(headers).toEqual({ source: "gateway", correlationId: "c-1" });
    expect(original).toEqual({ source: "gateway" });
  });

  it("withCorrelationId acepta headers ausentes y reemplaza un correlationId previo", () => {
    expect(withCorrelationId(undefined, "c-1")).toEqual({ correlationId: "c-1" });
    expect(withCorrelationId({ correlationId: "viejo" }, "nuevo")).toEqual({ correlationId: "nuevo" });
  });

  it.each([
    ["string", "c-1"],
    ["Buffer", Buffer.from("c-1")],
    ["arreglo", [Buffer.from("c-1"), "otro"]],
  ])("getCorrelationId lee el valor como %s", (_tipo, value) => {
    expect(getCorrelationId({ correlationId: value })).toBe("c-1");
  });

  it.each([[undefined], [{}], [{ correlationId: undefined }], [{ correlationId: "" }], [{ correlationId: [] }]])(
    "getCorrelationId devuelve undefined si no hay valor (%j)",
    (headers) => {
      expect(getCorrelationId(headers)).toBeUndefined();
    },
  );

  it("resolveCorrelationId conserva el que viene y genera uno nuevo si falta", () => {
    expect(resolveCorrelationId({ correlationId: "c-1" })).toBe("c-1");
    const generated = resolveCorrelationId(undefined);
    expect(generated).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolveCorrelationId(undefined)).not.toBe(generated);
  });

  it.each(["c-1", "a", "A.b_c:d-e", "6f1c1b0e-8a0f-4b53-9b53-2a9f4a3b7c11", "x".repeat(128)])("acepta el formato válido %#", (id) => {
    expect(isValidCorrelationId(id)).toBe(true);
    expect(withCorrelationId(undefined, id)).toEqual({ correlationId: id });
  });

  it.each([
    ["vacío", ""],
    ["129 caracteres", "x".repeat(129)],
    ["con espacio", "a b"],
    ["con salto de línea", "abc\nINFO falso"],
    ["con tabulación", "a\tb"],
    ["con barra", "a/b"],
    ["con comillas", 'a"b'],
    ["con acento", "corrélation"],
    ["con emoji", "id-😀"],
  ])("rechaza %s", (_caso, id) => {
    expect(isValidCorrelationId(id)).toBe(false);
    expect(() => withCorrelationId(undefined, id)).toThrow(CorrelationIdError);
  });

  it("el error de withCorrelationId no repite el valor recibido", () => {
    expect(() => withCorrelationId(undefined, "abc\nINFO falso")).toThrow(/formato inválido/);
    expect(() => withCorrelationId(undefined, "abc\nINFO falso")).not.toThrow(/falso/);
  });

  it.each([["a b"], ["x".repeat(129)], ["abc\ndef"]])("getCorrelationId descarta un valor inválido (%#)", (value) => {
    expect(getCorrelationId({ correlationId: value })).toBeUndefined();
    expect(getCorrelationId({ correlationId: Buffer.from(value) })).toBeUndefined();
  });

  it("resolveCorrelationId reemplaza por un UUID un correlationId inválido", () => {
    const resolved = resolveCorrelationId({ correlationId: "no valido!" });

    expect(resolved).toMatch(/^[0-9a-f-]{36}$/);
  });
});
