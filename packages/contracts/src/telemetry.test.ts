import { describe, expect, it } from "vitest";
import {
  apiErrorSchema,
  batchAckSchema,
  batchAckTolerantSchema,
  DEVICE_TOKEN_PREFIX,
  deviceTokenSchema,
  MAX_BATCH_POINTS,
  telemetryBatchEnvelopeSchema,
  telemetryDlqMessageSchema,
  telemetryDlqMessageTolerantSchema,
  telemetryPointSchema,
  telemetryRawEventSchema,
} from "./telemetry.js";

const point = {
  eventId: "3f2b8c1e-5d4a-4e7b-9a61-2c8d0e5f7a10",
  vehicleId: "a1c4e9d2-7b3f-4c58-8e16-0d9f2b6a4c71",
  recordedAt: "2026-03-14T15:42:07.512-05:00",
  lon: -75.5636,
  lat: 6.2518,
  speedMps: 13.4,
  headingDeg: 87.5,
  accuracyM: 8.2,
  mocked: false,
  lowAccuracy: false,
};

const accepts = (overrides: Record<string, unknown>) => telemetryPointSchema.safeParse({ ...point, ...overrides }).success;

describe("telemetryPointSchema", () => {
  it("acepta un punto válido, con altitud ausente, nula o presente", () => {
    expect(accepts({})).toBe(true);
    expect(accepts({ altitudeM: null })).toBe(true);
    expect(accepts({ altitudeM: 1495.3 })).toBe(true);
  });

  it("acepta velocidad, rumbo y precisión nulos", () => {
    expect(accepts({ speedMps: null, headingDeg: null, accuracyM: null })).toBe(true);
  });

  it.each([
    ["lon > 180", { lon: 180.1 }],
    ["lon < -180", { lon: -180.1 }],
    ["lat > 90", { lat: 90.1 }],
    ["lat < -90", { lat: -90.1 }],
    ["lat NaN", { lat: Number.NaN }],
    ["lon Infinity", { lon: Number.POSITIVE_INFINITY }],
    ["recordedAt sin offset", { recordedAt: "2026-03-14T15:42:07.512" }],
    ["recordedAt no ISO", { recordedAt: "14/03/2026" }],
    ["eventId inválido", { eventId: "no-es-uuid" }],
    ["vehicleId inválido", { vehicleId: "123" }],
    ["velocidad negativa", { speedMps: -0.1 }],
    ["velocidad sobre la cota", { speedMps: 150.1 }],
    ["rumbo igual a 360", { headingDeg: 360 }],
    ["rumbo negativo", { headingDeg: -1 }],
    ["precisión 0", { accuracyM: 0 }],
    ["mocked ausente", { mocked: undefined }],
  ])("rechaza %s", (_name, overrides) => {
    expect(accepts(overrides)).toBe(false);
  });

  it("acepta los extremos de los rangos", () => {
    expect(accepts({ lon: 180, lat: 90, speedMps: 0, headingDeg: 0, recordedAt: "2026-03-14T20:42:07Z" })).toBe(true);
    expect(accepts({ lon: -180, lat: -90, speedMps: 150, headingDeg: 359.99 })).toBe(true);
  });
});

describe("telemetryBatchEnvelopeSchema", () => {
  const envelope = (points: unknown[]) => ({ schemaVersion: 1, sentAt: "2026-03-14T20:42:30Z", points });
  const pointsOf = (n: number) => Array.from({ length: n }, () => point);

  it("acepta de 1 a MAX_BATCH_POINTS puntos", () => {
    expect(MAX_BATCH_POINTS).toBe(500);
    expect(telemetryBatchEnvelopeSchema.safeParse(envelope(pointsOf(1))).success).toBe(true);
    expect(telemetryBatchEnvelopeSchema.safeParse(envelope(pointsOf(500))).success).toBe(true);
  });

  it("rechaza un lote vacío o de 501 puntos", () => {
    expect(telemetryBatchEnvelopeSchema.safeParse(envelope([])).success).toBe(false);
    expect(telemetryBatchEnvelopeSchema.safeParse(envelope(pointsOf(501))).success).toBe(false);
  });

  it("no valida cada punto: los inválidos pasan el envelope", () => {
    expect(telemetryBatchEnvelopeSchema.safeParse(envelope([{ basura: true }, 7, null])).success).toBe(true);
  });

  it("rechaza una versión distinta de 1 y la falta de sentAt", () => {
    expect(telemetryBatchEnvelopeSchema.safeParse({ ...envelope(pointsOf(1)), schemaVersion: 2 }).success).toBe(false);
    expect(telemetryBatchEnvelopeSchema.safeParse({ schemaVersion: 1, points: pointsOf(1) }).success).toBe(false);
  });
});

describe("telemetryRawEventSchema", () => {
  const event = {
    schemaVersion: 1,
    tenantId: "9d7e1b34-2a6c-4f08-b5d3-6e4a8c1f0b92",
    deviceId: "5b8a3f6c-1e9d-4a27-8c40-7f2e6d1b9a35",
    receivedAt: "2026-03-14T20:42:31.044Z",
    point,
  };

  it("acepta un evento válido con el punto anidado", () => {
    expect(telemetryRawEventSchema.parse(event).point.eventId).toBe(point.eventId);
  });

  it("rechaza un punto inválido anidado y un tenantId inválido", () => {
    expect(telemetryRawEventSchema.safeParse({ ...event, point: { ...point, lat: 91 } }).success).toBe(false);
    expect(telemetryRawEventSchema.safeParse({ ...event, tenantId: "x" }).success).toBe(false);
  });
});

describe("batchAckSchema y batchAckTolerantSchema", () => {
  const ack = (reason: string) => ({
    schemaVersion: 1,
    accepted: [point.eventId],
    rejected: [{ index: 0, eventId: null, reason }],
    serverTime: "2026-03-14T20:42:31.100Z",
  });

  it("ambas variantes aceptan los motivos conocidos", () => {
    expect(batchAckSchema.safeParse(ack("invalid_schema")).success).toBe(true);
    expect(batchAckSchema.safeParse(ack("vehicle_mismatch")).success).toBe(true);
    expect(batchAckTolerantSchema.parse(ack("vehicle_mismatch")).rejected[0]?.reason).toBe("vehicle_mismatch");
  });

  it.each(["invalid_schema", "vehicle_mismatch", "future_timestamp", "stale_timestamp"])(
    "%s es un motivo conocido en ambas variantes (todo es v1) y no cae en 'unknown'",
    (reason) => {
      expect(batchAckSchema.parse(ack(reason)).rejected[0]?.reason).toBe(reason);
      expect(batchAckTolerantSchema.parse(ack(reason)).rejected[0]?.reason).toBe(reason);
    },
  );

  it("el ACK lleva schemaVersion: sin versión se rechaza en ambas variantes, y la estricta solo acepta la 1", () => {
    const { schemaVersion: _omitted, ...withoutVersion } = ack("invalid_schema");

    expect(batchAckSchema.parse(ack("invalid_schema")).schemaVersion).toBe(1);
    expect(batchAckSchema.safeParse(withoutVersion).success).toBe(false);
    expect(batchAckTolerantSchema.safeParse(withoutVersion).success).toBe(false);
    expect(batchAckSchema.safeParse({ ...ack("invalid_schema"), schemaVersion: 2 }).success).toBe(false);
  });

  // Cambio de comportamiento deliberado (hallazgo M-b): un ACK v2 que el móvil no leyera lo haría reintentar el lote para siempre.
  it("la variante TOLERANTE del ACK lee una versión mayor (2), pero no una inválida (0, 1.5, texto)", () => {
    expect(batchAckTolerantSchema.parse({ ...ack("invalid_schema"), schemaVersion: 2 }).schemaVersion).toBe(2);
    expect(batchAckTolerantSchema.parse({ ...ack("invalid_schema"), schemaVersion: 7 }).accepted).toEqual([point.eventId]);
    for (const schemaVersion of [0, -1, 1.5, "1", null]) {
      expect(batchAckTolerantSchema.safeParse({ ...ack("invalid_schema"), schemaVersion }).success).toBe(false);
    }
  });

  it("la variante estricta rechaza un motivo desconocido", () => {
    expect(batchAckSchema.safeParse(ack("motivo_futuro")).success).toBe(false);
  });

  it("la variante tolerante lee un motivo desconocido como 'unknown' sin fallar", () => {
    const parsed = batchAckTolerantSchema.parse(ack("motivo_futuro"));

    expect(parsed.rejected[0]?.reason).toBe("unknown");
    expect(parsed.accepted).toEqual([point.eventId]);
  });

  it("rechaza un índice negativo o fraccionario y un eventId que no es uuid", () => {
    const bad = (rejected: unknown) => batchAckSchema.safeParse({ ...ack("invalid_schema"), rejected }).success;

    expect(bad([{ index: -1, eventId: null, reason: "invalid_schema" }])).toBe(false);
    expect(bad([{ index: 1.5, eventId: null, reason: "invalid_schema" }])).toBe(false);
    expect(bad([{ index: 0, eventId: "x", reason: "invalid_schema" }])).toBe(false);
  });
});

describe("telemetryDlqMessageSchema y su variante tolerante", () => {
  const dlq = (code: string) => ({
    schemaVersion: 1,
    source: "ingest-gateway",
    reason: { code, message: "punto inválido" },
    failedAt: "2026-03-14T20:43:02.000Z",
    tenantId: null,
    deviceId: null,
    vehicleId: null,
    eventId: null,
    attempts: 0,
    originalPayload: "no era JSON",
  });

  it("ambas aceptan los seis códigos conocidos (todo es v1) sin degradarlos a 'unknown'", () => {
    for (const code of ["invalid_schema", "vehicle_mismatch", "future_timestamp", "stale_timestamp", "outside_operating_area", "processing_failed"]) {
      expect(telemetryDlqMessageSchema.safeParse(dlq(code)).success).toBe(true);
      expect(telemetryDlqMessageTolerantSchema.parse(dlq(code)).reason.code).toBe(code);
    }
  });

  it("la variante estricta solo acepta schemaVersion 1; la TOLERANTE lee una versión mayor pero no una inválida (hallazgo M-b)", () => {
    expect(telemetryDlqMessageSchema.safeParse({ ...dlq("invalid_schema"), schemaVersion: 2 }).success).toBe(false);
    expect(telemetryDlqMessageTolerantSchema.parse({ ...dlq("invalid_schema"), schemaVersion: 2 }).schemaVersion).toBe(2);
    for (const schemaVersion of [0, 1.5, "1", null]) {
      expect(telemetryDlqMessageTolerantSchema.safeParse({ ...dlq("invalid_schema"), schemaVersion }).success).toBe(false);
    }
  });

  it("la estricta rechaza un código desconocido y la tolerante lo lee como 'unknown'", () => {
    expect(telemetryDlqMessageSchema.safeParse(dlq("codigo_futuro")).success).toBe(false);
    expect(telemetryDlqMessageTolerantSchema.parse(dlq("codigo_futuro")).reason.code).toBe("unknown");
  });

  it("exige originalPayload en ambas variantes: omitirlo o dejarlo undefined falla (regla 7)", () => {
    const { originalPayload: _omitted, ...withoutPayload } = dlq("invalid_schema");

    expect(telemetryDlqMessageSchema.safeParse(withoutPayload).success).toBe(false);
    expect(telemetryDlqMessageTolerantSchema.safeParse(withoutPayload).success).toBe(false);
    expect(telemetryDlqMessageSchema.safeParse({ ...withoutPayload, originalPayload: undefined }).success).toBe(false);
    expect(telemetryDlqMessageTolerantSchema.safeParse({ ...withoutPayload, originalPayload: undefined }).success).toBe(false);
  });

  it("acepta cualquier valor JSON como originalPayload (objeto, arreglo, string, número, booleano y null) y rechaza lo que no es JSON", () => {
    for (const originalPayload of [{ eventId: "x", nested: [1, null, { a: true }] }, [1, 2], "no era JSON", 42, false, null]) {
      expect(telemetryDlqMessageSchema.safeParse({ ...dlq("invalid_schema"), originalPayload }).success).toBe(true);
      expect(telemetryDlqMessageTolerantSchema.safeParse({ ...dlq("invalid_schema"), originalPayload }).success).toBe(true);
    }
    for (const originalPayload of [() => 1, { f: () => 1 }, 10n, Number.NaN, { nested: undefined }]) {
      expect(telemetryDlqMessageSchema.safeParse({ ...dlq("invalid_schema"), originalPayload }).success).toBe(false);
    }
  });

  it("truncatedFromBytes es opcional: un mensaje sin él parsea, y con él (entero >= 0) también", () => {
    expect(telemetryDlqMessageSchema.safeParse(dlq("invalid_schema")).success).toBe(true);
    expect(telemetryDlqMessageSchema.parse({ ...dlq("invalid_schema"), truncatedFromBytes: 20_480 }).truncatedFromBytes).toBe(20_480);
    expect(telemetryDlqMessageTolerantSchema.parse({ ...dlq("invalid_schema"), truncatedFromBytes: 0 }).truncatedFromBytes).toBe(0);
    expect(telemetryDlqMessageSchema.safeParse({ ...dlq("invalid_schema"), truncatedFromBytes: -1 }).success).toBe(false);
    expect(telemetryDlqMessageSchema.safeParse({ ...dlq("invalid_schema"), truncatedFromBytes: 1.5 }).success).toBe(false);
  });

  it("rechaza attempts negativo y un origen desconocido", () => {
    expect(telemetryDlqMessageSchema.safeParse({ ...dlq("invalid_schema"), attempts: -1 }).success).toBe(false);
    expect(telemetryDlqMessageSchema.safeParse({ ...dlq("invalid_schema"), source: "otro" }).success).toBe(false);
  });
});

describe("deviceTokenSchema", () => {
  const body = "Zk3Qx9Wm2LpR7vTn4YbHc8DfJ1sAe6UoG0iNhXwVqKE";

  it("acepta prefijo y 43 caracteres base64url", () => {
    expect(body).toHaveLength(43);
    expect(deviceTokenSchema.safeParse(`${DEVICE_TOKEN_PREFIX}${body}`).success).toBe(true);
    expect(deviceTokenSchema.safeParse(`${DEVICE_TOKEN_PREFIX}${"a-_".repeat(14)}a`).success).toBe(true);
  });

  it("rechaza sin prefijo, con otro prefijo y con largo incorrecto", () => {
    expect(deviceTokenSchema.safeParse(body).success).toBe(false);
    expect(deviceTokenSchema.safeParse(`xyz_${body}`).success).toBe(false);
    expect(deviceTokenSchema.safeParse(`${DEVICE_TOKEN_PREFIX}${body.slice(1)}`).success).toBe(false);
    expect(deviceTokenSchema.safeParse(`${DEVICE_TOKEN_PREFIX}${body}A`).success).toBe(false);
  });

  it("rechaza caracteres fuera de base64url, relleno y saltos de línea", () => {
    expect(deviceTokenSchema.safeParse(`${DEVICE_TOKEN_PREFIX}${body.slice(0, 42)}=`).success).toBe(false);
    expect(deviceTokenSchema.safeParse(`${DEVICE_TOKEN_PREFIX}${body.slice(0, 42)}+`).success).toBe(false);
    expect(deviceTokenSchema.safeParse(`${DEVICE_TOKEN_PREFIX}${body}\n`).success).toBe(false);
  });
});

describe("apiErrorSchema", () => {
  it("acepta cualquier código string no vacío, para poder crecer", () => {
    expect(apiErrorSchema.safeParse({ error: { code: "rate_limited", message: "Demasiadas solicitudes." } }).success).toBe(true);
    expect(apiErrorSchema.safeParse({ error: { code: "codigo_nuevo", message: "x" } }).success).toBe(true);
  });

  it("rechaza un cuerpo sin error o con código vacío", () => {
    expect(apiErrorSchema.safeParse({ code: "x", message: "y" }).success).toBe(false);
    expect(apiErrorSchema.safeParse({ error: { code: "", message: "y" } }).success).toBe(false);
  });
});
