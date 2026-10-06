import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeAlertCursor, encodeAlertCursor, InvalidCursorError } from "./alert-cursor.js";

const cursor = { raisedAt: "2026-10-06T12:00:00.123456Z", alertId: randomUUID() };

const encodeRaw = (value: unknown) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value), "utf8").toString("base64url");

describe("cursor de alertas", () => {
  it("ida y vuelta: conserva los microsegundos y el alertId", () => {
    expect(decodeAlertCursor(encodeAlertCursor(cursor))).toEqual(cursor);
  });

  it("es opaco: base64url sin caracteres que necesiten escape en una URL, y cabe en los 256 caracteres del contrato", () => {
    const encoded = encodeAlertCursor(cursor);

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encoded.length).toBeLessThanOrEqual(256);
  });

  it.each([
    ["texto que no es base64 de JSON", "esto-no-es-un-cursor"],
    ["JSON de otra forma", encodeRaw({ foo: "bar" })],
    ["JSON que no es un objeto", encodeRaw("[]")],
    ["otra versión", encodeRaw({ v: 2, r: cursor.raisedAt, a: cursor.alertId })],
    ["raisedAt con milisegundos (sin los microsegundos)", encodeRaw({ v: 1, r: "2026-10-06T12:00:00.123Z", a: cursor.alertId })],
    ["raisedAt con una inyección SQL", encodeRaw({ v: 1, r: "2026-10-06T12:00:00.123456Z'; DROP TABLE alerts;--", a: cursor.alertId })],
    ["una fecha inexistente", encodeRaw({ v: 1, r: "2026-13-45T25:61:61.000000Z", a: cursor.alertId })],
    ["alertId que no es uuid", encodeRaw({ v: 1, r: cursor.raisedAt, a: "no-uuid" })],
    ["alertId con una inyección SQL", encodeRaw({ v: 1, r: cursor.raisedAt, a: "' OR '1'='1" })],
    ["vacío", ""],
  ])("rechaza %s con InvalidCursorError", (_label, value) => {
    expect(() => decodeAlertCursor(value)).toThrow(InvalidCursorError);
  });
});
