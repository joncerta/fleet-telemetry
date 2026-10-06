import { describe, expect, it } from "vitest";
import { evaluateMessage as evaluateAt, MAX_POINT_AGE_MS } from "./evaluate-message.js";

const NOW = new Date("2026-03-14T20:00:00.000Z");
const DAY_MS = 86_400_000;
/** La hora del reloj entra por argumento: el dominio no la lee. */
const evaluateMessage = (value: string | null, now: Date = NOW) => evaluateAt(value, { now });
/** Estrecha el veredicto a los que llevan `original` e `ids` (todos menos `unsupported_version`, que se prueba aparte). */
const withPayload = (verdict: ReturnType<typeof evaluateMessage>) => {
  if (verdict.kind === "unsupported_version") throw new Error("Se esperaba un veredicto con original e ids.");
  return verdict;
};
const codeOf = (verdict: ReturnType<typeof evaluateMessage>) => (verdict.kind === "rejected" ? verdict.code : "valid");

const IDS = {
  tenantId: "9d7e1b34-2a6c-4f08-b5d3-6e4a8c1f0b92",
  deviceId: "5b8a3f6c-1e9d-4a27-8c40-7f2e6d1b9a35",
  vehicleId: "a1c4e9d2-7b3f-4c58-8e16-0d9f2b6a4c71",
  eventId: "3f2b8c1e-5d4a-4e7b-9a61-2c8d0e5f7a10",
};

const rawEvent = (pointOverrides: Record<string, unknown> = {}, rootOverrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  tenantId: IDS.tenantId,
  deviceId: IDS.deviceId,
  receivedAt: "2026-03-14T20:00:00.000Z",
  point: {
    eventId: IDS.eventId,
    vehicleId: IDS.vehicleId,
    recordedAt: "2026-03-14T19:59:30.000Z",
    lon: -75.5636,
    lat: 6.2518,
    speedMps: 12.5,
    headingDeg: 90,
    accuracyM: 8,
    mocked: false,
    lowAccuracy: false,
    ...pointOverrides,
  },
  ...rootOverrides,
});

const encode = (value: unknown) => JSON.stringify(value);

describe("evaluateMessage", () => {
  it("un evento válido dentro del área es valid, con el original tal como llegó y los ids conocidos", () => {
    const raw = rawEvent();

    const verdict = evaluateMessage(encode(raw));

    expect(verdict.kind).toBe("valid");
    if (verdict.kind !== "valid") return;
    expect(verdict.event.point.eventId).toBe(IDS.eventId);
    expect(verdict.original).toEqual(raw);
    expect(verdict.ids).toEqual(IDS);
  });

  it("el original conserva los campos que el esquema descarta (es lo que llegó, no lo que zod devuelve)", () => {
    const raw = rawEvent({ campoNuevo: "de una versión futura" });

    const verdict = withPayload(evaluateMessage(encode(raw)));

    expect(verdict.kind).toBe("valid");
    expect(verdict.original).toEqual(raw);
    if (verdict.kind === "valid") expect(verdict.event.point).not.toHaveProperty("campoNuevo");
  });

  describe("invalid_schema", () => {
    it("un texto que no es JSON: el original es el string tal cual y no hay ids", () => {
      const verdict = evaluateMessage("{no es json");

      expect(verdict).toMatchObject({
        kind: "rejected",
        code: "invalid_schema",
        original: "{no es json",
        ids: { tenantId: null, deviceId: null, vehicleId: null, eventId: null },
      });
    });

    it("sin valor (tombstone): el original es null", () => {
      expect(evaluateMessage(null)).toMatchObject({ kind: "rejected", code: "invalid_schema", original: null });
    });

    it("JSON que no cumple el esquema: el original es el valor parseado y el detalle nombra solo los campos", () => {
      const raw = rawEvent({ lat: 999, speedMps: -5 });

      const verdict = evaluateMessage(encode(raw));

      expect(verdict).toMatchObject({ kind: "rejected", code: "invalid_schema", original: raw });
      if (verdict.kind !== "rejected") return;
      expect(verdict.detail).toBe("Campos inválidos: point.lat, point.speedMps.");
      expect(verdict.detail).not.toMatch(/999|-5/);
      // Los ids que sí son uuid se rescatan para la DLQ.
      expect(verdict.ids).toEqual(IDS);
    });

    it.each([
      ["un arreglo", "[1,2]"],
      ["un número", "42"],
      ["un string JSON", '"hola"'],
      ["null", "null"],
    ])("JSON que es %s: no es un objeto", (_name, value) => {
      const verdict = withPayload(evaluateMessage(value));

      expect(verdict).toMatchObject({ kind: "rejected", code: "invalid_schema", detail: "El mensaje no es un objeto." });
      expect(verdict.original).toEqual(JSON.parse(value));
    });

    // Antes este test usaba schemaVersion 2. Cambio de comportamiento deliberado (hallazgo M-b): una versión MAYOR es unsupported_version
    // (ver "versión del esquema"); una versión que no es un entero >= 1 sigue siendo contenido roto.
    it("un campo del envelope roto (schemaVersion 0) es invalid_schema", () => {
      expect(evaluateMessage(encode(rawEvent({}, { schemaVersion: 0 })))).toMatchObject({ kind: "rejected", code: "invalid_schema" });
    });

    it("un id que no es uuid no se rescata (queda null)", () => {
      const verdict = withPayload(evaluateMessage(encode(rawEvent({ eventId: "no-uuid" }, { tenantId: 7 }))));

      expect(verdict.ids).toEqual({ tenantId: null, deviceId: IDS.deviceId, vehicleId: IDS.vehicleId, eventId: null });
    });

    it("un point que no es objeto no rompe la lectura de ids", () => {
      expect(withPayload(evaluateMessage(encode({ tenantId: IDS.tenantId, point: "texto" }))).ids).toEqual({
        tenantId: IDS.tenantId,
        deviceId: null,
        vehicleId: null,
        eventId: null,
      });
    });

    it("el detalle nunca cita valores del mensaje, solo nombres de campo", () => {
      const verdict = evaluateMessage(encode(rawEvent({ lon: 181, lat: -91, recordedAt: "ayer" })));

      expect(verdict.kind === "rejected" ? verdict.detail : "").not.toMatch(/181|-91|ayer/);
    });

    it("más de diez campos inválidos se resumen", () => {
      const verdict = evaluateMessage(encode({ schemaVersion: 1, tenantId: 1, deviceId: 2, receivedAt: 3, point: { a: 1 } }));

      expect(verdict.kind === "rejected" ? verdict.detail : "").toMatch(/^Campos inválidos: .+\.$/);
    });
  });

  describe("outside_operating_area", () => {
    it("un punto en Madrid es rechazado, con el original y los ids, y sin coordenadas en el detalle", () => {
      const raw = rawEvent({ lon: -3.7038, lat: 40.4168 });

      const verdict = evaluateMessage(encode(raw));

      expect(verdict).toMatchObject({
        kind: "rejected",
        code: "outside_operating_area",
        detail: "El punto está fuera del área de operación.",
        original: raw,
        ids: IDS,
      });
      expect(verdict.kind === "rejected" ? verdict.detail : "").not.toMatch(/3\.7|40\.4/);
    });

    it("un punto en el occidente de Panamá es rechazado", () => {
      expect(evaluateMessage(encode(rawEvent({ lon: -82.4333, lat: 8.4333 })))).toMatchObject({ kind: "rejected", code: "outside_operating_area" });
    });

    it("San Andrés es válido", () => {
      expect(evaluateMessage(encode(rawEvent({ lon: -81.7003, lat: 12.5847 }))).kind).toBe("valid");
    });

    it("el esquema se evalúa antes que el área: un punto de otro continente con un campo roto es invalid_schema", () => {
      expect(evaluateMessage(encode(rawEvent({ lon: -3.7038, lat: 40.4168, speedMps: -1 })))).toMatchObject({
        kind: "rejected",
        code: "invalid_schema",
      });
    });
  });

  // Defensa en profundidad, con una cota MÁS LAXA que la del gateway (7 días por defecto): el gateway pudo aceptar un punto
  // válido que espere días en Kafka si el processor estuvo caído, y rechazarlo con la cota del gateway sería perder datos que ya
  // se confirmaron al móvil. Solo se rechaza lo que supera la retención (90 días): se borraría en la siguiente pasada.
  describe("stale_timestamp", () => {
    const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();

    it("la cota es la retención de telemetry: 90 días", () => {
      expect(MAX_POINT_AGE_MS).toBe(90 * DAY_MS);
    });

    it("un punto de más de 90 días es rechazado como stale_timestamp, con el original y los ids, y sin fechas en el detalle", () => {
      const raw = rawEvent({ recordedAt: at(-90 * DAY_MS - 1) });

      const verdict = evaluateMessage(encode(raw));

      expect(verdict).toMatchObject({ kind: "rejected", code: "stale_timestamp", original: raw, ids: IDS });
      if (verdict.kind === "rejected") expect(verdict.detail).not.toMatch(/2025|2026|75.5636|6.2518/);
    });

    it("exactamente 90 días se acepta (la cota es inclusiva)", () => {
      expect(evaluateMessage(encode(rawEvent({ recordedAt: at(-90 * DAY_MS) }))).kind).toBe("valid");
    });

    it("NO usa la cota del gateway: puntos de 8, 30 y 89 días (que el gateway pudo aceptar y esperar en Kafka) se aceptan", () => {
      for (const days of [8, 30, 89]) {
        expect(evaluateMessage(encode(rawEvent({ recordedAt: at(-days * DAY_MS) }))).kind).toBe("valid");
      }
    });

    it("respeta el offset de la hora", () => {
      // 90 días antes de NOW, expresado con -05:00: 15:00-05:00 es 20:00Z.
      expect(evaluateMessage(encode(rawEvent({ recordedAt: "2025-12-14T15:00:00.000-05:00" }))).kind).toBe("valid");
      expect(codeOf(evaluateMessage(encode(rawEvent({ recordedAt: "2025-12-14T14:59:59.999-05:00" }))))).toBe("stale_timestamp");
    });

    it("el esquema va antes que la antigüedad, y la antigüedad antes que el área", () => {
      expect(codeOf(evaluateMessage(encode(rawEvent({ recordedAt: at(-200 * DAY_MS), lat: 999 }))))).toBe("invalid_schema");
      expect(codeOf(evaluateMessage(encode(rawEvent({ recordedAt: at(-200 * DAY_MS), lon: -3.7038, lat: 40.4168 }))))).toBe("stale_timestamp");
    });

    it("no mira la hora futura: ese filtro es del gateway", () => {
      expect(evaluateMessage(encode(rawEvent({ recordedAt: at(10 * DAY_MS) }))).kind).toBe("valid");
    });
  });

  // Hallazgo M-b: una versión mayor que la conocida no es un error del CONTENIDO (regla 7): es un productor desplegado antes que este
  // consumer. No va a la DLQ: el caso de uso detiene la partición hasta que se despliegue la versión nueva.
  describe("versión del esquema", () => {
    it.each([2, 3, 100])("schemaVersion %i (mayor que la conocida) es unsupported_version con la versión, sin original ni ids", (version) => {
      const verdict = evaluateMessage(encode(rawEvent({}, { schemaVersion: version })));

      expect(verdict).toEqual({ kind: "unsupported_version", version });
    });

    it("una versión mayor se reconoce aunque el resto del mensaje no cumpla el esquema conocido (puede ser otro formato)", () => {
      expect(evaluateMessage(encode({ schemaVersion: 2, formatoNuevo: true })).kind).toBe("unsupported_version");
    });

    it("la versión 1 sigue siendo válida", () => {
      expect(evaluateMessage(encode(rawEvent({}, { schemaVersion: 1 }))).kind).toBe("valid");
    });

    it.each([[0], [-1], [1.5], ["2"], [null], [Number.MAX_SAFE_INTEGER + 0.5]])(
      "schemaVersion %j no es una versión futura: es invalid_schema (contenido roto) y va a la DLQ",
      (version) => {
        expect(codeOf(evaluateMessage(encode(rawEvent({}, { schemaVersion: version }))))).toBe("invalid_schema");
      },
    );

    it("sin schemaVersion, o en un mensaje que no es un objeto, es invalid_schema", () => {
      const { schemaVersion: _omitted, ...withoutVersion } = rawEvent();

      expect(codeOf(evaluateMessage(encode(withoutVersion)))).toBe("invalid_schema");
      expect(codeOf(evaluateMessage(encode([{ schemaVersion: 2 }])))).toBe("invalid_schema");
      expect(codeOf(evaluateMessage(encode(2)))).toBe("invalid_schema");
    });
  });
});
