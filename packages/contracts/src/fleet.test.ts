import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  alertEventSchema,
  alertEventTolerantSchema,
  alertIdName,
  alertSchema,
  alertsQuerySchema,
  alertsResponseTolerantSchema,
  compareSeq,
  devicePairRequestSchema,
  devicePairResponseSchema,
  devicePairResponseTolerantSchema,
  fleetSummarySchema,
  hasNoSignal,
  isNewerSeq,
  loginRequestSchema,
  NO_SIGNAL_THRESHOLD_MS,
  PAIRING_CODE_ALPHABET,
  pairingCodeSchema,
  sessionSchema,
  sseSnapshotSchema,
  sseSnapshotTolerantSchema,
  sseVehicleStateTolerantSchema,
  stoppedVehiclesQuerySchema,
  stoppedVehiclesResponseTolerantSchema,
  vehicleStateEventSchema,
  vehicleStateEventTolerantSchema,
  vehicleStateSchema,
  vehicleStateTolerantSchema,
  zoneFeatureCollectionSchema,
  zoneFeatureCollectionTolerantSchema,
} from "./index.js";

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/${name}/v1.json`, import.meta.url)), "utf8")) as Record<string, unknown>;

const state = fixture("vehicle-state");
const alert = fixture("alert");

describe("seq: bigint como string", () => {
  it.each(["0", "1", "1042", "9007199254740993", "9223372036854775807"])("acepta %s", (value) => {
    expect(vehicleStateSchema.safeParse({ ...state, seq: value }).success).toBe(true);
  });

  it.each(["", "-1", "01", "1.5", "1e3", " 1", "abc", "9223372036854775808", "99999999999999999999", 1042, null])("rechaza %j", (value) => {
    expect(vehicleStateSchema.safeParse({ ...state, seq: value }).success).toBe(false);
  });

  it("compara como entero, no como texto ni como number (pierde precisión pasado 2^53)", () => {
    expect(compareSeq("9", "10")).toBeLessThan(0);
    expect(compareSeq("10", "9")).toBeGreaterThan(0);
    expect(compareSeq("42", "42")).toBe(0);
    expect(compareSeq("9007199254740993", "9007199254740992")).toBeGreaterThan(0);
    expect(Number("9007199254740993")).toBe(Number("9007199254740992")); // el motivo de no usar number
  });

  it("isNewerSeq aplica un evento solo si supera al que ya se tiene (y siempre si no hay ninguno)", () => {
    expect(isNewerSeq("11", "10")).toBe(true);
    expect(isNewerSeq("10", "10")).toBe(false);
    expect(isNewerSeq("9", "10")).toBe(false);
    expect(isNewerSeq("1", undefined)).toBe(true);
  });
});

describe("vehicleState", () => {
  it("lleva identificación, posición, los dos tiempos, movimiento, zonas y seq", () => {
    expect(vehicleStateSchema.parse(state)).toMatchObject({ movement: "stopped", stoppedSince: "2026-03-14T15:21:50.000-05:00", seq: "1042" });
  });

  it("speedMps y headingDeg admiten null; movement moving lleva stoppedSince null", () => {
    expect(vehicleStateSchema.safeParse({ ...state, speedMps: null, headingDeg: null, movement: "moving", stoppedSince: null }).success).toBe(true);
  });

  it.each([
    ["lon fuera de rango", { lon: 181 }],
    ["lat fuera de rango", { lat: -91 }],
    ["sin recordedAt", { recordedAt: undefined }],
    ["recordedAt sin offset", { recordedAt: "2026-03-14T15:42:07" }],
    ["receivedAt inválido", { receivedAt: "ayer" }],
    ["movement no_signal (no es un estado del processor)", { movement: "no_signal" }],
    ["zoneIds con un no-uuid", { zoneIds: ["zona-1"] }],
    ["headingDeg 360", { headingDeg: 360 }],
    ["sin seq", { seq: undefined }],
  ])("rechaza %s", (_label, override) => {
    expect(vehicleStateSchema.safeParse({ ...state, ...override }).success).toBe(false);
  });

  it("la estricta rechaza un movement desconocido y la tolerante lo lee como unknown, conservando el resto", () => {
    const future = { ...state, movement: "idle" };

    expect(vehicleStateSchema.safeParse(future).success).toBe(false);
    expect(vehicleStateTolerantSchema.parse(future)).toMatchObject({ movement: "unknown", plate: "ABC123", seq: "1042" });
  });

  it("ignora campos desconocidos de una versión posterior (z.object)", () => {
    expect(vehicleStateSchema.parse({ ...state, fuel: 0.4 })).not.toHaveProperty("fuel");
  });
});

describe("alert", () => {
  it("la estricta acepta los dos tipos; zoneId, zoneName y resolvedAt admiten null", () => {
    expect(alertSchema.parse(alert).resolvedAt).toBeNull();
    expect(alertSchema.safeParse({ ...alert, type: "mocked_location", zoneId: null, zoneName: null }).success).toBe(true);
  });

  it("la estricta rechaza un tipo desconocido y la tolerante lo lee como unknown", () => {
    const future = { ...alert, type: "speeding" };

    expect(alertSchema.safeParse(future).success).toBe(false);
    expect(alertEventSchema.safeParse({ schemaVersion: 1, tenantId: state.vehicleId, alert: future }).success).toBe(false);
    expect(alertEventTolerantSchema.parse({ schemaVersion: 1, tenantId: state.vehicleId, alert: future }).alert.type).toBe("unknown");
  });

  it("alertId debe ser un uuid", () => {
    expect(alertSchema.safeParse({ ...alert, alertId: "no-es-uuid" }).success).toBe(false);
  });

  it("alertIdName es determinista y normaliza el instante: el mismo startedAt con otro offset da el mismo nombre", () => {
    const a = alertIdName("A1C4E9D2-7B3F-4C58-8E16-0D9F2B6A4C71", "critical_zone_stop", "2026-03-14T15:21:50.000-05:00");
    const b = alertIdName("a1c4e9d2-7b3f-4c58-8e16-0d9f2b6a4c71", "critical_zone_stop", "2026-03-14T20:21:50Z");

    expect(a).toBe(b);
    expect(a).toBe("a1c4e9d2-7b3f-4c58-8e16-0d9f2b6a4c71|critical_zone_stop|2026-03-14T20:21:50.000Z");
    expect(alertIdName("a1c4e9d2-7b3f-4c58-8e16-0d9f2b6a4c71", "mocked_location", "2026-03-14T20:21:50Z")).not.toBe(a);
  });
});

describe("eventos de Kafka", () => {
  const event = fixture("vehicle-state-event");

  it("la estricta solo acepta schemaVersion 1 y la tolerante cualquier entero >= 1", () => {
    expect(vehicleStateEventSchema.safeParse({ ...event, schemaVersion: 2 }).success).toBe(false);
    expect(vehicleStateEventTolerantSchema.safeParse({ ...event, schemaVersion: 2 }).success).toBe(true);
    expect(vehicleStateEventTolerantSchema.safeParse({ ...event, schemaVersion: 0 }).success).toBe(false);
    expect(vehicleStateEventTolerantSchema.safeParse({ ...event, schemaVersion: "1" }).success).toBe(false);
  });

  it("exige tenantId uuid: el tenant del evento sale del processor, no del cliente", () => {
    expect(vehicleStateEventSchema.safeParse({ ...event, tenantId: "norte" }).success).toBe(false);
    expect(vehicleStateEventSchema.safeParse({ schemaVersion: 1, state }).success).toBe(false);
  });

  it("la tolerante lee un movement desconocido dentro del evento", () => {
    const parsed = vehicleStateEventTolerantSchema.parse({ ...event, schemaVersion: 2, state: { ...state, movement: "idle" } });
    expect(parsed.state.movement).toBe("unknown");
  });
});

describe("zonas GeoJSON", () => {
  const zones = fixture("zone-feature-collection") as { features: { geometry: { coordinates: number[][][] }; properties: Record<string, unknown> }[] };

  it("es una FeatureCollection de Polygon con [lng, lat] y properties { zoneId, name, kind }", () => {
    const parsed = zoneFeatureCollectionSchema.parse(zones);

    expect(parsed.type).toBe("FeatureCollection");
    expect(parsed.features[0]?.properties.kind).toBe("critical");
    // [lng, lat]: la longitud de Bogotá es negativa y va primero.
    expect(parsed.features[0]?.geometry.coordinates[0]?.[0]).toEqual([-74.075, 4.708]);
  });

  it("rechaza una posición cuya segunda coordenada (la latitud) está fuera de rango", () => {
    // El contrato no puede detectar un `[lat, lng]` invertido de Colombia (-74 es una latitud válida): solo el rango. Ese error lo
    // atrapa la validación de la zona en la base (Colombia) y el orden `[lng, lat]` de la regla 13.
    const swapped = structuredClone(zones);
    swapped.features[0]!.geometry.coordinates[0] = [[4, -120], [4, -119], [5, -119], [4, -120]];
    expect(zoneFeatureCollectionSchema.safeParse(swapped).success).toBe(false);
  });

  it("admite una altitud como tercer valor de la posición (GeoJSON) y rechaza un anillo con menos de 4 posiciones", () => {
    const withAltitude = structuredClone(zones);
    withAltitude.features[0]!.geometry.coordinates[0] = [[-74, 4, 2600], [-73, 4, 2600], [-73, 5, 2600], [-74, 4, 2600]];
    expect(zoneFeatureCollectionSchema.safeParse(withAltitude).success).toBe(true);

    const open = structuredClone(zones);
    open.features[0]!.geometry.coordinates[0] = [[-74, 4], [-73, 4], [-73, 5]];
    expect(zoneFeatureCollectionSchema.safeParse(open).success).toBe(false);
  });

  it("solo admite Polygon", () => {
    const point = structuredClone(zones) as unknown as { features: { geometry: Record<string, unknown> }[] };
    point.features[0]!.geometry = { type: "Point", coordinates: [-74, 4] };
    expect(zoneFeatureCollectionSchema.safeParse(point).success).toBe(false);
  });

  it("un kind desconocido: la estricta falla y la tolerante lo lee como unknown", () => {
    const future = structuredClone(zones);
    future.features[0]!.properties.kind = "fuel_station";

    expect(zoneFeatureCollectionSchema.safeParse(future).success).toBe(false);
    expect(zoneFeatureCollectionTolerantSchema.parse(future).features[0]?.properties.kind).toBe("unknown");
  });
});

describe("resumen", () => {
  it("lleva la hora del servidor, los conteos y las alertas activas", () => {
    expect(fleetSummarySchema.parse(fixture("fleet-summary"))).toMatchObject({ vehicles: { total: 15, noSignal: 2 }, activeAlerts: 1 });
  });

  it("rechaza conteos negativos o fraccionarios y la falta de serverTime", () => {
    const summary = fixture("fleet-summary") as { vehicles: Record<string, number> };
    expect(fleetSummarySchema.safeParse({ ...summary, vehicles: { ...summary.vehicles, moving: -1 } }).success).toBe(false);
    expect(fleetSummarySchema.safeParse({ ...summary, vehicles: { ...summary.vehicles, stopped: 1.5 } }).success).toBe(false);
    expect(fleetSummarySchema.safeParse({ ...summary, serverTime: undefined }).success).toBe(false);
  });

  it("hasNoSignal: más de 5 minutos de receivedAt contra la hora del servidor (estrictamente más)", () => {
    const server = "2026-03-14T20:45:00.000Z";
    expect(NO_SIGNAL_THRESHOLD_MS).toBe(300_000);
    expect(hasNoSignal("2026-03-14T20:40:00.000Z", server)).toBe(false); // exactamente 5 minutos
    expect(hasNoSignal("2026-03-14T20:39:59.999Z", server)).toBe(true);
    expect(hasNoSignal("2026-03-14T15:39:59.999-05:00", server)).toBe(true); // otro offset, mismo instante
    expect(hasNoSignal("2026-03-14T20:45:30.000Z", server)).toBe(false); // un receivedAt "futuro" no es sin señal
  });
});

describe("vehículos detenidos", () => {
  it("la consulta aplica los valores por defecto (20 minutos, 50 resultados, sin zona)", () => {
    expect(stoppedVehiclesQuerySchema.parse({})).toEqual({ minMinutes: 20, limit: 50 });
  });

  it("convierte el texto de la querystring en números", () => {
    expect(stoppedVehiclesQuerySchema.parse({ minMinutes: "45", zoneKind: "depot", limit: "10" })).toEqual({ minMinutes: 45, zoneKind: "depot", limit: 10 });
  });

  it.each([
    [{ minMinutes: "0" }],
    [{ minMinutes: "1441" }],
    [{ minMinutes: "1.5" }],
    [{ minMinutes: "veinte" }],
    [{ limit: "0" }],
    [{ limit: "201" }],
    [{ zoneKind: "parking" }],
  ])("rechaza %j", (query) => {
    expect(stoppedVehiclesQuerySchema.safeParse(query).success).toBe(false);
  });

  it("acepta los extremos 1, 1440, 1 y 200", () => {
    expect(stoppedVehiclesQuerySchema.safeParse({ minMinutes: "1", limit: "1" }).success).toBe(true);
    expect(stoppedVehiclesQuerySchema.safeParse({ minMinutes: "1440", limit: "200" }).success).toBe(true);
  });

  it("la respuesta tolerante lee un zone.kind desconocido y conserva zone null", () => {
    const response = fixture("stopped-vehicles-response") as { items: { zone: Record<string, unknown> | null }[] };
    response.items[0]!.zone!.kind = "fuel_station";

    const parsed = stoppedVehiclesResponseTolerantSchema.parse(response);

    expect(parsed.items[0]?.zone?.kind).toBe("unknown");
    expect(parsed.items[1]?.zone).toBeNull();
  });
});

describe("alertas", () => {
  it("la consulta tiene por defecto las activas y 50 por página; el cursor es opcional", () => {
    expect(alertsQuerySchema.parse({})).toEqual({ status: "active", limit: 50 });
    expect(alertsQuerySchema.parse({ status: "all", limit: "200", cursor: "abc" })).toEqual({ status: "all", limit: 200, cursor: "abc" });
  });

  it.each([[{ status: "resolved" }], [{ limit: "0" }], [{ limit: "201" }], [{ cursor: "" }], [{ cursor: "x".repeat(257) }]])("rechaza %j", (query) => {
    expect(alertsQuerySchema.safeParse(query).success).toBe(false);
  });

  it("la respuesta lleva nextCursor nullable y la tolerante lee un type desconocido", () => {
    const response = fixture("alerts-response") as { items: Record<string, unknown>[]; nextCursor: string | null };
    expect(alertsResponseTolerantSchema.parse({ ...response, nextCursor: null }).nextCursor).toBeNull();

    response.items[0]!.type = "speeding";
    expect(alertsResponseTolerantSchema.parse(response).items[0]?.type).toBe("unknown");
  });
});

describe("SSE", () => {
  const snapshot = fixture("sse-snapshot");

  it("el snapshot lleva hora del servidor, cursor ordenable, vehículos y alertas activas", () => {
    const parsed = sseSnapshotSchema.parse(snapshot);

    expect(parsed.cursor).toBe("1043");
    expect(parsed.vehicles).toHaveLength(2);
    expect(parsed.alerts).toHaveLength(1);
  });

  it("el cursor es el máximo seq incluido (el fixture lo cumple) y admite '0' con un snapshot vacío", () => {
    const parsed = sseSnapshotSchema.parse(snapshot);
    const seqs = [...parsed.vehicles.map((v) => v.seq), ...parsed.alerts.map((a) => a.seq)];
    expect(seqs.reduce((max, current) => (compareSeq(current, max) > 0 ? current : max))).toBe(parsed.cursor);

    expect(sseSnapshotSchema.safeParse({ serverTime: "2026-03-14T20:42:09.000Z", cursor: "0", vehicles: [], alerts: [] }).success).toBe(true);
  });

  it("la tolerante lee un snapshot con estados y alertas de valores desconocidos", () => {
    const future = structuredClone(snapshot) as { vehicles: Record<string, unknown>[]; alerts: Record<string, unknown>[] };
    future.vehicles[0]!.movement = "idle";
    future.alerts[0]!.type = "speeding";

    expect(sseSnapshotSchema.safeParse(future).success).toBe(false);
    const parsed = sseSnapshotTolerantSchema.parse(future);
    expect(parsed.vehicles[0]?.movement).toBe("unknown");
    expect(parsed.alerts[0]?.type).toBe("unknown");
  });

  it("vehicle.state lleva { state } y alert lleva { alert }", () => {
    expect(sseVehicleStateTolerantSchema.parse({ state }).state.seq).toBe("1042");
    expect(sseVehicleStateTolerantSchema.safeParse({ alert }).success).toBe(false);
  });
});

describe("sesión", () => {
  it("el login exige un correo válido y una contraseña no vacía", () => {
    expect(loginRequestSchema.safeParse(fixture("login-request")).success).toBe(true);
    expect(loginRequestSchema.safeParse({ email: "no-es-correo", password: "x" }).success).toBe(false);
    expect(loginRequestSchema.safeParse({ email: "a@b.test", password: "" }).success).toBe(false);
    expect(loginRequestSchema.safeParse({ email: "a@b.test", password: "x".repeat(257) }).success).toBe(false);
  });

  it("la sesión lleva usuario y tenant, sin el token ni la cookie", () => {
    const session = sessionSchema.parse(fixture("session"));

    expect(Object.keys(session).sort()).toEqual(["tenant", "user"]);
    expect(session.tenant.name).toBe("Flota Norte");
  });
});

describe("vinculación del dispositivo", () => {
  it("el alfabeto del código tiene 32 símbolos sin ambiguos (0, O, 1, I)", () => {
    expect(PAIRING_CODE_ALPHABET).toHaveLength(32);
    expect(new Set(PAIRING_CODE_ALPHABET).size).toBe(32);
    for (const ambiguous of ["0", "O", "1", "I"]) expect(PAIRING_CODE_ALPHABET).not.toContain(ambiguous);
  });

  it.each(["K7M2QX9P", "ABCDEFGH", "23456789"])("acepta el código %s", (code) => {
    expect(devicePairRequestSchema.safeParse({ code }).success).toBe(true);
    expect(pairingCodeSchema.safeParse({ ...fixture("pairing-code"), code }).success).toBe(true);
  });

  it.each(["K7M2QX9", "K7M2QX9PP", "k7m2qx9p", "K7M2QX0P", "K7M2QXOP", "K7M2QX1P", "K7M2QXIP", "K7M2-X9P", "", "K7M2QX9 "])("rechaza el código %j", (code) => {
    expect(devicePairRequestSchema.safeParse({ code }).success).toBe(false);
  });

  it("la respuesta estricta exige el formato exacto del token y la tolerante cualquier token fdt_ no vacío", () => {
    const response = fixture("device-pair-response");
    const longer = { ...response, deviceToken: "fdt_token-de-otra-longitud-de-una-version-posterior" };

    expect(devicePairResponseSchema.safeParse(response).success).toBe(true);
    expect(devicePairResponseSchema.safeParse(longer).success).toBe(false);
    expect(devicePairResponseTolerantSchema.safeParse(longer).success).toBe(true);
    expect(devicePairResponseTolerantSchema.safeParse({ ...response, deviceToken: "fdt_" }).success).toBe(false);
    expect(devicePairResponseTolerantSchema.safeParse({ ...response, deviceToken: "otro_formato" }).success).toBe(false);
  });
});
