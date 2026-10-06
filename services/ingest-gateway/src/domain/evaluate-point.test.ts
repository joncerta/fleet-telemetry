import { telemetryDlqMessageSchema } from "@fleet/contracts";
import { describe, expect, it } from "vitest";
import { evaluatePoint, ORIGINAL_PAYLOAD_PREVIEW_CHARS, type PointRules } from "./evaluate-point.js";

const VEHICLE = "a1c4e9d2-7b3f-4c58-8e16-0d9f2b6a4c71";
const OTHER_VEHICLE = "7c1d5e92-4b0a-4d63-9f28-3a6b8e0c4d17";
const EVENT = "3f2b8c1e-5d4a-4e7b-9a61-2c8d0e5f7a10";
const NOW = new Date("2026-03-14T20:00:00.000Z");
const DAY_MS = 86_400_000;
const MAX_POINT_BYTES = 8_192;
const rules: PointRules = { vehicleId: VEHICLE, now: NOW, futureToleranceMs: 5 * 60_000, maxAgeMs: 7 * DAY_MS, maxPointBytes: MAX_POINT_BYTES };

const validPoint = (overrides: Record<string, unknown> = {}) => ({
  eventId: EVENT,
  vehicleId: VEHICLE,
  recordedAt: "2026-03-14T19:59:30.000Z",
  lon: -75.5636,
  lat: 6.2518,
  speedMps: 12.5,
  headingDeg: 90,
  accuracyM: 8,
  mocked: false,
  lowAccuracy: false,
  ...overrides,
});

function rejection(raw: unknown, ruleOverrides: Partial<PointRules> = {}) {
  const verdict = evaluatePoint(raw, { ...rules, ...ruleOverrides });
  if (verdict.accepted) throw new Error("se esperaba un rechazo");
  return verdict.rejection;
}

describe("evaluatePoint", () => {
  it("acepta un punto válido del vehículo del token", () => {
    const verdict = evaluatePoint(validPoint(), rules);

    expect(verdict).toMatchObject({ accepted: true, point: { eventId: EVENT } });
  });

  describe("invalid_schema", () => {
    it("rechaza un punto que no cumple telemetryPointSchema y nombra los campos, sin valores", () => {
      const result = rejection(validPoint({ lat: 91.5, lon: "no-es-numero" }));

      expect(result.reason).toBe("invalid_schema");
      expect(result.detail).toContain("lat");
      expect(result.detail).toContain("lon");
      expect(result.detail).not.toMatch(/91\.5|no-es-numero/);
      expect(result.eventId).toBe(EVENT);
    });

    it.each([
      ["null", null],
      ["un número", 42],
      ["un string", "punto"],
      ["un arreglo", [1, 2]],
    ])("rechaza %s como invalid_schema, con eventId null", (_label, raw) => {
      const result = rejection(raw);

      expect(result).toMatchObject({ reason: "invalid_schema", eventId: null });
      expect(result.detail).toBe("El punto no es un objeto.");
    });

    it("eventId es null si falta o no es un uuid", () => {
      expect(rejection({ ...validPoint(), eventId: "no-uuid" }).eventId).toBeNull();
      expect(rejection({ ...validPoint(), eventId: undefined }).eventId).toBeNull();
    });

    it("una hora sin offset es invalid_schema", () => {
      expect(rejection(validPoint({ recordedAt: "2026-03-14 19:59:30" })).reason).toBe("invalid_schema");
    });

    it("conserva el punto original tal como llegó, también cuando es inválido", () => {
      const raw = validPoint({ lat: 500 });

      expect(rejection(raw).original).toEqual(raw);
    });

    it("limita cuántos campos nombra el detalle", () => {
      const manyBad = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`campo${i}`, i]));

      const result = rejection(manyBad);

      expect(result.detail.length).toBeLessThan(400);
    });
  });

  describe("vehicle_mismatch", () => {
    it("rechaza un punto de otro vehículo, sin revelar ningún vehículo en el detalle", () => {
      const result = rejection(validPoint({ vehicleId: OTHER_VEHICLE }));

      expect(result.reason).toBe("vehicle_mismatch");
      expect(result.detail).not.toContain(OTHER_VEHICLE);
      expect(result.detail).not.toContain(VEHICLE);
      expect(result.eventId).toBe(EVENT);
    });

    it("compara el uuid sin distinguir mayúsculas", () => {
      expect(evaluatePoint(validPoint({ vehicleId: VEHICLE.toUpperCase() }), rules).accepted).toBe(true);
    });

    it("un punto inválido y de otro vehículo es invalid_schema (el esquema va primero)", () => {
      expect(rejection(validPoint({ vehicleId: OTHER_VEHICLE, lat: 200 })).reason).toBe("invalid_schema");
    });
  });

  describe("future_timestamp", () => {
    it("rechaza recordedAt por encima de now + tolerancia", () => {
      const result = rejection(validPoint({ recordedAt: "2026-03-14T20:05:00.001Z" }));

      expect(result.reason).toBe("future_timestamp");
      expect(result.detail).not.toMatch(/2026/);
    });

    it("acepta exactamente now + tolerancia (la cota es inclusiva)", () => {
      expect(evaluatePoint(validPoint({ recordedAt: "2026-03-14T20:05:00.000Z" }), rules).accepted).toBe(true);
    });

    it("respeta el offset de la hora: las 15:04-05:00 son las 20:04Z (dentro de la tolerancia) y las 15:06-05:00 no", () => {
      expect(evaluatePoint(validPoint({ recordedAt: "2026-03-14T15:04:00-05:00" }), rules).accepted).toBe(true);
      expect(rejection(validPoint({ recordedAt: "2026-03-14T15:06:00-05:00" })).reason).toBe("future_timestamp");
    });

    it("la tolerancia es un parámetro: con 0 cualquier adelanto se rechaza", () => {
      expect(rejection(validPoint({ recordedAt: "2026-03-14T20:00:00.001Z" }), { futureToleranceMs: 0 }).reason).toBe("future_timestamp");
    });

    it("un vehículo distinto va antes que la hora futura", () => {
      expect(rejection(validPoint({ vehicleId: OTHER_VEHICLE, recordedAt: "2030-01-01T00:00:00Z" })).reason).toBe("vehicle_mismatch");
    });
  });

  describe("stale_timestamp", () => {
    // NOW - 7 días = 2026-03-07T20:00:00.000Z
    it("rechaza recordedAt anterior a now - antigüedad máxima, aunque sea por 1 ms", () => {
      const result = rejection(validPoint({ recordedAt: "2026-03-07T19:59:59.999Z" }));

      expect(result.reason).toBe("stale_timestamp");
      expect(result.detail).not.toMatch(/2026/);
      expect(result.eventId).toBe(EVENT);
    });

    it("acepta exactamente now - antigüedad máxima (la cota es inclusiva)", () => {
      expect(evaluatePoint(validPoint({ recordedAt: "2026-03-07T20:00:00.000Z" }), rules).accepted).toBe(true);
    });

    it("respeta el offset de la hora: las 14:59:59.999-05:00 del 7 son las 19:59:59.999Z (vieja) y las 15:00:00-05:00 son las 20:00Z (límite)", () => {
      expect(rejection(validPoint({ recordedAt: "2026-03-07T14:59:59.999-05:00" })).reason).toBe("stale_timestamp");
      expect(evaluatePoint(validPoint({ recordedAt: "2026-03-07T15:00:00.000-05:00" }), rules).accepted).toBe(true);
    });

    it("la antigüedad máxima es un parámetro: con 1 hora, un punto de hace 61 minutos se rechaza y uno de hace 59 no", () => {
      const oneHour = { maxAgeMs: 3_600_000 };

      expect(rejection(validPoint({ recordedAt: "2026-03-14T18:59:00.000Z" }), oneHour).reason).toBe("stale_timestamp");
      expect(evaluatePoint(validPoint({ recordedAt: "2026-03-14T19:01:00.000Z" }), { ...rules, ...oneHour }).accepted).toBe(true);
    });

    it.each([
      ["una hora", "2026-03-14T19:00:00.000Z"],
      ["seis días", "2026-03-08T20:00:00.000Z"],
    ])("acepta un punto de hace %s", (_label, recordedAt) => {
      expect(evaluatePoint(validPoint({ recordedAt }), rules).accepted).toBe(true);
    });

    it.each([
      ["ocho días", "2026-03-06T20:00:00.000Z"],
      ["un año", "2025-03-14T20:00:00.000Z"],
      ["cinco años (más que la retención)", "2021-03-14T20:00:00.000Z"],
    ])("rechaza un punto de hace %s", (_label, recordedAt) => {
      expect(rejection(validPoint({ recordedAt })).reason).toBe("stale_timestamp");
    });

    it("el esquema y el vehículo van antes que la antigüedad", () => {
      expect(rejection(validPoint({ lat: 200, recordedAt: "2020-01-01T00:00:00Z" })).reason).toBe("invalid_schema");
      expect(rejection(validPoint({ vehicleId: OTHER_VEHICLE, recordedAt: "2020-01-01T00:00:00Z" })).reason).toBe("vehicle_mismatch");
    });
  });

  describe("tamaño máximo del punto (invalid_schema, con el payload truncado en la DLQ)", () => {
    const sizeOf = (raw: unknown) => new TextEncoder().encode(JSON.stringify(raw)).length;
    /** El `original` de un rechazo por tamaño es el inicio del JSON, un string. */
    const previewOf = (raw: unknown): string => {
      const { original } = rejection(raw);
      if (typeof original !== "string") throw new Error("El original debía ser el inicio del punto (un string)");
      return original;
    };
    /** Punto válido con un campo de relleno: el esquema descarta lo desconocido, así que solo el tamaño lo rechaza. */
    const padded = (bytes: number) => {
      const base = validPoint({ relleno: "" });
      return validPoint({ relleno: "x".repeat(bytes - sizeOf(base)) });
    };

    it("rechaza un punto de maxPointBytes + 1 bytes como invalid_schema, nombrando el límite pero no el contenido", () => {
      const raw = padded(MAX_POINT_BYTES + 1);

      const result = rejection(raw);

      expect(result.reason).toBe("invalid_schema");
      expect(result.detail).toContain(String(MAX_POINT_BYTES));
      expect(result.detail).not.toMatch(/xxxx|6.2518|75.5636/);
      expect(result.eventId).toBe(EVENT);
    });

    it("acepta un punto de exactamente maxPointBytes bytes (la cota es inclusiva)", () => {
      const raw = padded(MAX_POINT_BYTES);

      expect(sizeOf(raw)).toBe(MAX_POINT_BYTES);
      expect(evaluatePoint(raw, rules).accepted).toBe(true);
    });

    it("guarda solo el inicio del JSON (un string de a lo sumo ORIGINAL_PAYLOAD_PREVIEW_CHARS) y su tamaño original en bytes", () => {
      const raw = padded(20_000);

      const result = rejection(raw);

      expect(result.truncatedFromBytes).toBe(20_000);
      const preview = previewOf(raw);
      expect(preview.length).toBeLessThanOrEqual(ORIGINAL_PAYLOAD_PREVIEW_CHARS);
      expect(JSON.stringify(raw).startsWith(preview)).toBe(true);
      expect(preview).toContain(EVENT);
    });

    it("mide bytes UTF-8, no caracteres: 4 000 emojis (16 000 bytes) superan el límite aunque sean pocos caracteres", () => {
      const raw = validPoint({ relleno: "😀".repeat(4_000) });

      const result = rejection(raw);

      expect(result.reason).toBe("invalid_schema");
      expect(result.truncatedFromBytes).toBe(sizeOf(raw));
    });

    it("no parte un par sustituto al truncar: el inicio guardado es un string bien formado", () => {
      const raw = { relleno: "😀".repeat(5_000) };

      const preview = previewOf(raw);

      expect(preview.isWellFormed()).toBe(true);
    });

    it("un valor que no es objeto pero es enorme (un string) también se rechaza y se trunca", () => {
      const result = rejection("y".repeat(MAX_POINT_BYTES + 100));

      expect(result).toMatchObject({ reason: "invalid_schema", eventId: null });
      expect(result.truncatedFromBytes).toBeGreaterThan(MAX_POINT_BYTES);
    });

    it("un rechazo pequeño NO lleva truncatedFromBytes y conserva el original completo", () => {
      const raw = validPoint({ lat: 500 });

      const result = rejection(raw);

      expect(result.truncatedFromBytes).toBeUndefined();
      expect(result.original).toEqual(raw);
    });
  });

  it("el original de cada rechazo es un valor válido para originalPayload de la DLQ", () => {
    const samples = [validPoint({ lat: 500 }), validPoint({ vehicleId: OTHER_VEHICLE }), validPoint({ recordedAt: "2030-01-01T00:00:00Z" }), null, "x"];

    for (const raw of samples) {
      const parsed = telemetryDlqMessageSchema.shape.originalPayload.safeParse(rejection(raw).original);
      expect(parsed.success).toBe(true);
    }
  });
});
