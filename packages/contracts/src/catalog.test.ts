import { describe, expect, it } from "vitest";
import {
  userListItemSchema,
  userListQuerySchema,
  userListResponseSchema,
  vehicleCatalogItemSchema,
  vehicleCreateRequestSchema,
  vehicleListQuerySchema,
  vehicleListResponseSchema,
} from "./index.js";

const vehicle = { vehicleId: "3c9e7a10-5b2d-4e6f-9a81-7d4c0b2e5f13", plate: "ABC123", label: null, hasActiveDevice: false, createdAt: "2026-10-06T12:00:00.000Z" };

describe("alta de vehículo (vehicleCreateRequestSchema)", () => {
  it.each([
    ["abc123", "ABC123"],
    ["  abc-123  ", "ABC123"],
    ["ABC 123", "ABC123"],
    ["a-b c--1 2-3", "ABC123"],
    ["Abc12d", "ABC12D"],
    ["X", "X"],
    ["ABC123\n", "ABC123"],
    ["A".repeat(32), "A".repeat(32)],
  ])("normaliza la placa %j a %j", (input, expected) => {
    expect(vehicleCreateRequestSchema.parse({ plate: input }).plate).toBe(expected);
  });

  it.each(["", "   ", "A".repeat(33), "-", " - ", "--", "ÁBC123", "ABC_123", "AB.C"])("rechaza la placa %j", (plate) => {
    expect(vehicleCreateRequestSchema.safeParse({ plate }).success).toBe(false);
  });

  it("rechaza una placa ausente o que no es texto", () => {
    expect(vehicleCreateRequestSchema.safeParse({}).success).toBe(false);
    expect(vehicleCreateRequestSchema.safeParse({ plate: 123456 }).success).toBe(false);
  });

  it.each([
    [undefined, null],
    [null, null],
    ["", null],
    ["   ", null],
    ["  Camión 7  ", "Camión 7"],
    ["a".repeat(64), "a".repeat(64)],
  ])("la etiqueta %j se guarda como %j", (label, expected) => {
    expect(vehicleCreateRequestSchema.parse({ plate: "ABC123", label }).label).toBe(expected);
  });

  it("ABC-123, ABC 123 y abc123 son la misma placa canónica", () => {
    const plates = ["ABC-123", "abc 123", "abc123"].map((plate) => vehicleCreateRequestSchema.parse({ plate }).plate);

    expect(new Set(plates)).toEqual(new Set(["ABC123"]));
  });

  it.each(["a\u0000b", "\u202Eabc", "a\u2066b", "a\u0007b", "a\nb"])("rechaza la etiqueta %j (caracteres de control o bidi)", (label) => {
    expect(vehicleCreateRequestSchema.safeParse({ plate: "ABC123", label }).success).toBe(false);
  });

  it("rechaza una etiqueta de más de 64 caracteres", () => {
    expect(vehicleCreateRequestSchema.safeParse({ plate: "ABC123", label: "a".repeat(65) }).success).toBe(false);
  });

  it("descarta un tenantId del cuerpo: el tenant sale de la sesión", () => {
    const parsed = vehicleCreateRequestSchema.parse({ plate: "ABC123", tenantId: "9d7e1b34-2a6c-4f08-b5d3-6e4a8c1f0b92" });

    expect(Object.keys(parsed).sort()).toEqual(["label", "plate"]);
  });
});

describe("catálogo de vehículos", () => {
  it("el vehículo lleva hasActiveDevice y una etiqueta nula o no vacía", () => {
    expect(vehicleCatalogItemSchema.safeParse(vehicle).success).toBe(true);
    expect(vehicleCatalogItemSchema.safeParse({ ...vehicle, label: "Camión 7" }).success).toBe(true);
    expect(vehicleCatalogItemSchema.safeParse({ ...vehicle, label: "" }).success).toBe(false);
    expect(vehicleCatalogItemSchema.safeParse({ ...vehicle, hasActiveDevice: undefined }).success).toBe(false);
  });

  it("la consulta toma 200 por defecto, convierte el texto y acota de 1 a 500", () => {
    expect(vehicleListQuerySchema.parse({}).limit).toBe(200);
    expect(vehicleListQuerySchema.parse({ limit: "500" }).limit).toBe(500);
    for (const limit of ["0", "501", "1.5", "abc"]) expect(vehicleListQuerySchema.safeParse({ limit }).success).toBe(false);
  });

  it("la respuesta lleva items y el limit aplicado", () => {
    expect(vehicleListResponseSchema.safeParse({ items: [vehicle], limit: 200 }).success).toBe(true);
    expect(vehicleListResponseSchema.safeParse({ items: [vehicle] }).success).toBe(false);
  });
});

describe("listado de usuarios", () => {
  const user = { userId: "f1a3b5c7-9d0e-4f1a-8b2c-3d4e5f6a7b8c", name: "Operador Norte", email: "operador@norte.test", createdAt: "2026-10-06T12:00:00.000Z" };

  it("el usuario no admite ni conserva el hash de la contraseña", () => {
    const parsed = userListItemSchema.parse({ ...user, passwordHash: "scrypt$..." });

    expect(Object.keys(parsed).sort()).toEqual(["createdAt", "email", "name", "userId"]);
    expect(userListResponseSchema.parse({ items: [{ ...user, password_hash: "x" }] }).items[0]).toEqual(user);
  });

  it("la consulta toma 100 por defecto y acota de 1 a 500", () => {
    expect(userListQuerySchema.parse({}).limit).toBe(100);
    expect(userListQuerySchema.parse({ limit: "500" }).limit).toBe(500);
    for (const limit of ["0", "501"]) expect(userListQuerySchema.safeParse({ limit }).success).toBe(false);
  });
});
