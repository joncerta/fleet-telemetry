import { describe, expect, it } from "vitest";
import {
  COLOMBIA_BBOX,
  INVALID_GEOMETRY_ERROR_CODE,
  isInsideBoundingBox,
  vehicleCreateRequestSchema,
  ZONE_LIMIT_REACHED_ERROR_CODE,
  ZONE_MAX_PER_TENANT,
  ZONE_MAX_VERTICES,
  ZONE_NAME_MAX_LENGTH,
  ZONE_NAME_TAKEN_ERROR_CODE,
  zoneCreateRequestSchema,
  zoneFeatureCollectionSchema,
  zoneFeatureSchema,
  zoneFeatureTolerantSchema,
} from "./index.js";

const square = [
  [-74.08, 4.7],
  [-74.07, 4.7],
  [-74.07, 4.71],
  [-74.08, 4.71],
  [-74.08, 4.7],
];
const body = (ring: unknown = square, extra: Record<string, unknown> = {}) => ({
  name: "Zona crítica Norte",
  kind: "critical",
  geometry: { type: "Polygon", coordinates: [ring] },
  ...extra,
});

// Caracteres problemáticos construidos por código: un NUL o un bidi escritos tal cual en el fuente se pierden o confunden al leerlo.
const NUL = String.fromCharCode(0x0000);
const RLO = String.fromCharCode(0x202e);
const ISOLATE = String.fromCharCode(0x2066);
const ZWSP = String.fromCharCode(0x200b);
const LRM = String.fromCharCode(0x200e);
const RLM = String.fromCharCode(0x200f);
const ALM = String.fromCharCode(0x061c);
const WORD_JOINER = String.fromCharCode(0x2060);
const BOM = String.fromCharCode(0xfeff);
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/** Polígono regular de `vertices` vértices dentro de Colombia, cerrado. */
function ringOf(vertices: number): number[][] {
  const points = Array.from({ length: vertices }, (_, i) => {
    const angle = (2 * Math.PI * i) / vertices;
    return [-74 + 0.05 * Math.cos(angle), 4.7 + 0.05 * Math.sin(angle)];
  });
  return [...points, points[0] as number[]];
}

function messagesOf(input: unknown): string[] {
  const result = zoneCreateRequestSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

describe("constantes del alta de zonas", () => {
  it("expone los nombres y valores acordados", () => {
    expect(ZONE_NAME_MAX_LENGTH).toBe(80);
    expect(ZONE_MAX_VERTICES).toBe(200);
    expect(ZONE_NAME_TAKEN_ERROR_CODE).toBe("zone_name_taken");
    expect(INVALID_GEOMETRY_ERROR_CODE).toBe("invalid_geometry");
    expect(ZONE_LIMIT_REACHED_ERROR_CODE).toBe("zone_limit_reached");
    expect(ZONE_MAX_PER_TENANT).toBe(1_000);
    expect(COLOMBIA_BBOX).toEqual({ minLon: -82.0, maxLon: -66.8, minLat: -4.3, maxLat: 13.6 });
  });
});

describe("zoneCreateRequestSchema", () => {
  it("acepta una zona válida y recorta el nombre", () => {
    const parsed = zoneCreateRequestSchema.parse(body(square, { name: "  Depósito Sur  ", kind: "depot" }));

    expect(parsed).toEqual({ name: "Depósito Sur", kind: "depot", geometry: { type: "Polygon", coordinates: [square] } });
  });

  it.each(["critical", "depot", "customer"])("acepta el tipo %s", (kind) => {
    expect(zoneCreateRequestSchema.safeParse(body(square, { kind })).success).toBe(true);
  });

  it.each(["unknown", "", "CRITICAL", 3])("rechaza el tipo %j", (kind) => {
    expect(zoneCreateRequestSchema.safeParse(body(square, { kind })).success).toBe(false);
  });

  it("descarta un tenantId o un zoneId del cuerpo", () => {
    const parsed = zoneCreateRequestSchema.parse(
      body(square, { tenantId: "9d7e1b34-2a6c-4f08-b5d3-6e4a8c1f0b92", zoneId: "c3d5e7f9-1a2b-4c4d-8e6f-0a1b2c3d4e5f" }),
    );

    expect(Object.keys(parsed).sort()).toEqual(["geometry", "kind", "name"]);
  });

  it("acepta el límite de vértices y rechaza uno más", () => {
    expect(zoneCreateRequestSchema.safeParse(body(ringOf(ZONE_MAX_VERTICES))).success).toBe(true);
    expect(messagesOf(body(ringOf(ZONE_MAX_VERTICES + 1))).join(" ")).toContain(`a lo sumo ${ZONE_MAX_VERTICES} vértices`);
  });

  it("rechaza un anillo abierto con un mensaje claro", () => {
    const messages = messagesOf(body([...square.slice(0, 4), [-74.09, 4.69]]));

    expect(messages).toContain("El anillo debe estar cerrado: la última posición debe ser igual a la primera.");
  });

  it("rechaza menos de 4 posiciones", () => {
    expect(messagesOf(body(square.slice(0, 3))).join(" ")).toContain("al menos 4 posiciones");
  });

  it("rechaza menos de 3 vértices distintos aunque haya 4 posiciones cerradas", () => {
    const degenerate = [
      [-74.08, 4.7],
      [-74.07, 4.7],
      [-74.07, 4.7],
      [-74.08, 4.7],
    ];

    expect(messagesOf(body(degenerate))).toContain("El polígono necesita al menos 3 vértices distintos.");
  });

  it("rechaza un anillo vacío sin lanzar", () => {
    expect(zoneCreateRequestSchema.safeParse(body([])).success).toBe(false);
  });

  it("rechaza un polígono fuera de Colombia (Madrid)", () => {
    const madrid = [
      [-3.71, 40.41],
      [-3.7, 40.41],
      [-3.7, 40.42],
      [-3.71, 40.42],
      [-3.71, 40.41],
    ];

    expect(messagesOf(body(madrid)).join(" ")).toContain("dentro de Colombia");
  });

  it("rechaza un solo vértice fuera del área, aunque los demás estén dentro", () => {
    const ring = [...square.slice(0, 2), [-60, 4.71], ...square.slice(3)];

    expect(zoneCreateRequestSchema.safeParse(body(ring)).success).toBe(false);
  });

  it("detecta el orden lat/lon invertido con el bbox (Bogotá como [lat, lon])", () => {
    const swapped = square.map(([lng, lat]) => [lat, lng]);

    expect(messagesOf(body(swapped)).join(" ")).toContain("[longitud, latitud]");
  });

  it("los bordes del bbox cuentan como dentro", () => {
    const { minLon, maxLon, minLat, maxLat } = COLOMBIA_BBOX;
    const edge = [
      [minLon, minLat],
      [maxLon, minLat],
      [maxLon, maxLat],
      [minLon, maxLat],
      [minLon, minLat],
    ];

    expect(zoneCreateRequestSchema.safeParse(body(edge)).success).toBe(true);
  });

  it("rechaza un polígono con huecos (más de un anillo) o sin anillos", () => {
    const hole = [
      [-74.078, 4.702],
      [-74.072, 4.702],
      [-74.072, 4.708],
      [-74.078, 4.702],
    ];

    expect(zoneCreateRequestSchema.safeParse({ ...body(), geometry: { type: "Polygon", coordinates: [square, hole] } }).success).toBe(false);
    expect(zoneCreateRequestSchema.safeParse({ ...body(), geometry: { type: "Polygon", coordinates: [] } }).success).toBe(false);
  });

  it.each([
    ["es un Point", { type: "Point", coordinates: [-74, 4.7] }],
    ["es un MultiPolygon", { type: "MultiPolygon", coordinates: [[square]] }],
  ])("rechaza una geometría que %s", (_label, geometry) => {
    expect(zoneCreateRequestSchema.safeParse({ ...body(), geometry }).success).toBe(false);
  });

  it("rechaza posiciones con altitud, no numéricas o no finitas", () => {
    expect(zoneCreateRequestSchema.safeParse(body(square.map(([a, b]) => [a, b, 100]))).success).toBe(false);
    expect(zoneCreateRequestSchema.safeParse(body([...square.slice(0, 4), ["-74.08", 4.7]])).success).toBe(false);
    expect(zoneCreateRequestSchema.safeParse(body([...square.slice(0, 3), [Number.NaN, 4.71], square[4]])).success).toBe(false);
  });

  it.each([
    ["vacío", ""],
    ["de solo espacios", "   "],
    ["largo de más", "a".repeat(ZONE_NAME_MAX_LENGTH + 1)],
    ["con NUL", `a${NUL}b`],
    ["con salto de línea", "a\nb"],
    ["con bidi RLO", `${RLO}abc`],
    ["con aislamiento bidi", `a${ISOLATE}b`],
    ["formado solo por U+200B", ZWSP.repeat(3)],
    ["con U+200B interno", `a${ZWSP}b`],
    ["con LRM", `a${LRM}b`],
    ["con RLM", `a${RLM}b`],
    ["con U+061C", `a${ALM}b`],
    ["con U+2060", `a${WORD_JOINER}b`],
    ["con U+FEFF interno", `a${BOM}b`],
    ["con separador de línea", `a${LINE_SEPARATOR}b`],
    ["con separador de párrafo", `a${PARAGRAPH_SEPARATOR}b`],
  ])("rechaza un nombre %s", (_label, name) => {
    expect(zoneCreateRequestSchema.safeParse(body(square, { name })).success).toBe(false);
  });

  it("normaliza el nombre a NFC: compuesto y descompuesto dan el mismo nombre", () => {
    const nfc = "Depósito".normalize("NFC");
    const nfd = nfc.normalize("NFD");

    expect(nfc).not.toBe(nfd);
    expect(zoneCreateRequestSchema.parse(body(square, { name: nfd })).name).toBe(nfc);
    expect(zoneCreateRequestSchema.parse(body(square, { name: nfc })).name).toBe(nfc);
  });

  it("un U+FEFF al borde se recorta como espacio, pero uno interno se rechaza", () => {
    expect(zoneCreateRequestSchema.parse(body(square, { name: `${BOM}Zona` })).name).toBe("Zona");
  });

  it("acepta un nombre del largo máximo (tras recortar)", () => {
    expect(zoneCreateRequestSchema.safeParse(body(square, { name: ` ${"a".repeat(ZONE_NAME_MAX_LENGTH)} ` })).success).toBe(true);
  });

  it.each(["name", "kind", "geometry"])("rechaza un cuerpo sin %s", (key) => {
    const complete: Record<string, unknown> = body();
    delete complete[key];

    expect(zoneCreateRequestSchema.safeParse(complete).success).toBe(false);
  });
});

describe("zoneFeatureSchema", () => {
  const feature = {
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [square] },
    properties: { zoneId: "c3d5e7f9-1a2b-4c4d-8e6f-0a1b2c3d4e5f", name: "Zona", kind: "critical" },
  };

  it("acepta un Feature y la colección sigue aceptando el mismo Feature", () => {
    expect(zoneFeatureSchema.safeParse(feature).success).toBe(true);
    expect(zoneFeatureCollectionSchema.parse({ type: "FeatureCollection", features: [feature] }).features).toEqual([feature]);
  });

  it("la estricta rechaza un kind desconocido y la tolerante lo lee como unknown", () => {
    const future = { ...feature, properties: { ...feature.properties, kind: "warehouse" } };

    expect(zoneFeatureSchema.safeParse(future).success).toBe(false);
    expect(zoneFeatureTolerantSchema.parse(future).properties.kind).toBe("unknown");
  });
});

describe("isInsideBoundingBox", () => {
  it("usa Colombia por defecto, con la longitud primero y los bordes dentro", () => {
    expect(isInsideBoundingBox(-74.07, 4.71)).toBe(true);
    expect(isInsideBoundingBox(4.71, -74.07)).toBe(false);
    expect(isInsideBoundingBox(COLOMBIA_BBOX.minLon, COLOMBIA_BBOX.minLat)).toBe(true);
    expect(isInsideBoundingBox(COLOMBIA_BBOX.maxLon + 0.001, 4)).toBe(false);
  });
});

describe("etiqueta de vehículo con el patrón compartido", () => {
  it.each([`a${ZWSP}b`, `a${LRM}b`, `a${BOM}b`, `a${ALM}b`])("rechaza la etiqueta %j (formato invisible)", (label) => {
    expect(vehicleCreateRequestSchema.safeParse({ plate: "ABC123", label }).success).toBe(false);
  });

  it("sigue aceptando texto normal con acentos", () => {
    expect(vehicleCreateRequestSchema.parse({ plate: "ABC123", label: "Camión 7 ñandú" }).label).toBe("Camión 7 ñandú");
  });
});
