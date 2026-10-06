import { describe, expect, it } from "vitest";
import { createLogger, MAX_REDACTION_DEPTH, REDACTED, redactDeep, serializeError, TRUNCATED, withContext } from "./logger.js";

function setup(level: "debug" | "info" = "info") {
  const lines: string[] = [];
  const logger = createLogger({ service: "test-service", level, destination: { write: (line) => void lines.push(line) } });
  const entries = (): Record<string, unknown>[] => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger, entries };
}

describe("createLogger", () => {
  it("emite JSON con servicio, nivel textual y hora ISO", () => {
    const { logger, entries } = setup();

    logger.info({ speed: 42 }, "punto procesado");

    const [entry] = entries();
    expect(entry).toMatchObject({ service: "test-service", level: "info", msg: "punto procesado", speed: 42 });
    expect(new Date(String(entry?.time)).toISOString()).toBe(entry?.time);
  });

  it("respeta el nivel configurado", () => {
    const { logger, entries } = setup("info");

    logger.debug("no sale");

    expect(entries()).toEqual([]);
  });
});

describe("redacción de datos personales (regla 14)", () => {
  it.each([
    "lat", "lon", "lng", "long", "latitude", "longitude", "Latitude", "LAT", "Lng",
    "position", "location", "coordinates", "coords",
    "driver", "driverId", "driverName", "driver_name", "driverLicense", "conductor", "conductorName", "DriverPhone",
    "geom", "geometry", "point", "wkt", "geojson", "GeoJSON", "plate", "Plate", "placa", "PLACA", "address", "direccion",
    "DRIVERNAME", "driver-name", "licensePlate", "label", "Label", "name", "email", "Email", "EMAIL",
  ])("redacta `%s` en el nivel raíz", (key) => {
    const { logger, entries } = setup();

    logger.info({ [key]: "valor-sensible-123", vehicleId: "veh-1" }, "evento");

    expect(entries()[0]).toMatchObject({ [key]: REDACTED, vehicleId: "veh-1" });
  });

  it.each(["lat", "lng", "longitude", "position", "location", "coordinates", "driverName", "driver_id"])(
    "redacta `%s` un nivel anidado",
    (key) => {
      const { logger, entries } = setup();

      logger.info({ payload: { [key]: "valor-sensible-123", speed: 10 } }, "evento");

      expect(entries()[0]).toMatchObject({ payload: { [key]: REDACTED, speed: 10 } });
    },
  );

  it("redacta en arreglos anidados a 2 niveles: { points: [{ lat, lon }] }", () => {
    const { logger, entries } = setup();

    logger.info({ points: [{ lat: 4.7, lon: -74.1, speed: 9 }] }, "evento");

    expect(entries()[0]).toMatchObject({ points: [{ lat: REDACTED, lon: REDACTED, speed: 9 }] });
  });

  it("redacta en arreglos anidados a 3 niveles: { batch: { points: [{ lat, lon }] } }", () => {
    const { logger, entries } = setup();

    logger.info({ batch: { id: "b-1", points: [{ lat: 4.7, lon: -74.1 }, { Lat: 4.8, LON: -74.2 }] } }, "evento");

    expect(entries()[0]).toMatchObject({
      batch: { id: "b-1", points: [{ lat: REDACTED, lon: REDACTED }, { Lat: REDACTED, LON: REDACTED }] },
    });
  });

  it("redacta { rejected: [{ payload: { position } }] } a 4 niveles", () => {
    const { logger, entries } = setup();

    logger.info({ rejected: [{ eventId: "e-1", payload: { position: { lat: 4.7, lng: -74.1 } } }] }, "evento");

    expect(entries()[0]).toMatchObject({ rejected: [{ eventId: "e-1", payload: { position: REDACTED } }] });
  });

  it("recorre arreglos dentro de arreglos", () => {
    const { logger, entries } = setup();

    logger.info({ groups: [[{ plate: "ABC123" }], [{ placa: "XYZ987" }]] }, "evento");

    expect(entries()[0]).toMatchObject({ groups: [[{ plate: REDACTED }], [{ placa: REDACTED }]] });
  });

  it("descarta lo que queda más allá del límite de profundidad en vez de filtrarlo", () => {
    const lines: string[] = [];
    const logger = createLogger({ service: "s", destination: { write: (line) => void lines.push(line) } });
    let deep: Record<string, unknown> = { lat: 4.711, other: "texto" };
    for (let i = 0; i < MAX_REDACTION_DEPTH + 2; i++) deep = { next: deep };

    logger.info(deep, "evento");

    expect(lines.join("")).not.toMatch(/4.711/);
    expect(lines.join("")).toContain(TRUNCATED);
  });

  it("no pierde un objeto circular ni tumba el log", () => {
    const { logger, entries } = setup();
    const loop: Record<string, unknown> = { lat: 4.7 };
    loop.self = loop;

    logger.info({ loop }, "evento");

    expect(entries()[0]).toMatchObject({ msg: "evento", loop: { lat: REDACTED } });
  });

  it("conserva el serializador de errores y no recorre sus propiedades", () => {
    const { logger, entries } = setup();

    logger.error({ err: new Error("falló") }, "evento");

    expect(entries()[0]).toMatchObject({ err: { type: "Error", message: "falló" } });
  });

  it("no modifica el objeto que recibió el logger", () => {
    const { logger } = setup();
    const input = { batch: { points: [{ lat: 4.7 }] } };

    logger.info(input, "evento");

    expect(input).toEqual({ batch: { points: [{ lat: 4.7 }] } });
  });

  it("redacta objetos y arreglos completos de posición", () => {
    const { logger, entries } = setup();

    logger.info({ position: { lat: 4.7, lng: -74.1 }, coordinates: [-74.1, 4.7], driver: { name: "Ana", id: 7 } }, "evento");

    expect(entries()[0]).toMatchObject({ position: REDACTED, coordinates: REDACTED, driver: REDACTED });
  });

  it("no deja ningún valor sensible en la línea emitida", () => {
    const lines: string[] = [];
    const logger = createLogger({ service: "s", destination: { write: (line) => void lines.push(line) } });

    logger.info({ lat: 4.711, lng: -74.072, payload: { latitude: 4.711, driverName: "Ana Pérez" }, vehicleId: "veh-1" }, "evento");

    expect(lines.join("")).not.toMatch(/4\.711|74\.072|Ana/);
  });

  it("no toca los campos que no son datos personales", () => {
    const { logger, entries } = setup();

    logger.info({ vehicleId: "veh-1", tenantId: "t-1", speedKmh: 33, nested: { status: "moving" } }, "evento");

    expect(entries()[0]).toMatchObject({ vehicleId: "veh-1", tenantId: "t-1", speedKmh: 33, nested: { status: "moving" } });
  });
});

describe("withContext", () => {
  it("agrega correlationId, tenantId y vehicleId a cada línea del hijo", () => {
    const { logger, entries } = setup();

    withContext(logger, { correlationId: "c-1", tenantId: "t-1", vehicleId: "v-1" }).info("hola");

    expect(entries()[0]).toMatchObject({ correlationId: "c-1", tenantId: "t-1", vehicleId: "v-1" });
  });

  it("omite las claves sin valor en vez de escribir null o undefined", () => {
    const { logger, entries } = setup();

    withContext(logger, { correlationId: "c-1", vehicleId: undefined }).info("hola");

    const [entry] = entries();
    expect(entry).toMatchObject({ correlationId: "c-1" });
    expect(entry).not.toHaveProperty("tenantId");
    expect(entry).not.toHaveProperty("vehicleId");
  });
});

describe("segunda red de seguridad: propiedades de child() (regla 14)", () => {
  it("redacta `position` en los bindings de un logger hijo", () => {
    const lines: string[] = [];
    const logger = createLogger({ service: "s", destination: { write: (line) => void lines.push(line) } });

    logger.child({ position: { lat: 4.711 } }).info("x");

    expect(lines.join("")).not.toContain("4.711");
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ position: REDACTED, msg: "x" });
  });

  it.each([
    ["lat", { lat: 4.711 }],
    ["driverName", { driverName: "Ana 4.711" }],
    ["driver_name", { driver_name: "Ana 4.711" }],
    ["driver-name", { "driver-name": "Ana 4.711" }],
    ["Latitude", { Latitude: 4.711 }],
    ["licensePlate", { licensePlate: "ABC 4.711" }],
    ["un nivel anidado", { context: { location: { lat: 4.711 } } }],
  ])("redacta %s en un hijo, y en un nieto", (_caso, bindings) => {
    const lines: string[] = [];
    const logger = createLogger({ service: "s", destination: { write: (line) => void lines.push(line) } });

    logger.child(bindings).child({ vehicleId: "veh-1" }).info("x");

    expect(lines.join("")).not.toContain("4.711");
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ vehicleId: "veh-1" });
  });

  it("no toca los bindings que no son datos personales", () => {
    const { logger, entries } = setup();

    logger.child({ correlationId: "c-1", tenantId: "t-1", vehicleId: "v-1", route: "/api" }).info("x");

    expect(entries()[0]).toMatchObject({ correlationId: "c-1", tenantId: "t-1", vehicleId: "v-1", route: "/api" });
  });
});

describe("serializador de errores sin el detail de pg (regla 14)", () => {
  const pgError = () =>
    Object.assign(new Error("new row violates check constraint"), {
      code: "23514",
      detail: "Failing row contains (4.711, -74.07)",
      where: "SQL statement INSERT ... VALUES (4.711, -74.07)",
      internalQuery: "SELECT 4.711",
      hint: "revisa -74.07",
      constraint: "points_lat_check",
    });

  it("quita detail, where, internalQuery y hint, y conserva tipo, mensaje, code y constraint", () => {
    const lines: string[] = [];
    const logger = createLogger({ service: "s", destination: { write: (line) => void lines.push(line) } });

    logger.error({ err: Object.assign(new Error("x"), { code: "23514", detail: "Failing row contains (4.711, -74.07)" }) });

    const raw = lines.join("");
    expect(raw).not.toContain("4.711");
    expect(raw).not.toContain("-74.07");
    const entry = JSON.parse(raw) as { err: Record<string, unknown> };
    expect(entry).toMatchObject({ err: { type: "Error", message: "x", code: "23514" } });
    expect(entry.err).not.toHaveProperty("detail");
  });

  it("quita las cuatro propiedades y conserva las demás", () => {
    const { logger, entries } = setup();

    logger.error({ err: pgError() }, "falló");

    const err = entries()[0]?.err as Record<string, unknown>;
    expect(err).toMatchObject({ code: "23514", constraint: "points_lat_check", message: "new row violates check constraint" });
    for (const key of ["detail", "where", "internalQuery", "hint"]) expect(err).not.toHaveProperty(key);
  });

  it("con un error con cause (estándar y con detail en la causa) no filtra la fila", () => {
    const lines: string[] = [];
    const logger = createLogger({ service: "s", destination: { write: (line) => void lines.push(line) } });
    const wrapped = new Error("no se pudo guardar el punto", { cause: pgError() });

    logger.error({ err: wrapped }, "falló");

    const raw = lines.join("");
    expect(raw).not.toContain("4.711");
    expect(raw).not.toContain("-74.07");
    expect(raw).toContain("no se pudo guardar el punto");
  });

  it("limpia errores anidados en propiedades y en aggregateErrors", () => {
    const lines: string[] = [];
    const logger = createLogger({ service: "s", destination: { write: (line) => void lines.push(line) } });
    const holder = Object.assign(new Error("externo"), { original: pgError() });
    const aggregate = new AggregateError([pgError()], "varios");

    logger.error({ err: holder }, "a");
    logger.error({ err: aggregate }, "b");

    const raw = lines.join("");
    expect(raw).not.toContain("4.711");
    expect(raw).not.toContain("-74.07");
    expect(raw).toContain("points_lat_check");
  });

  it("también cuando el error va en la clave `error` o en un hijo", () => {
    const lines: string[] = [];
    const logger = createLogger({ service: "s", destination: { write: (line) => void lines.push(line) } });

    logger.error({ error: pgError() }, "a");
    logger.child({ err: pgError() }).error("b");

    expect(lines.join("")).not.toMatch(/4\.711|-74\.07/);
  });

  it("deja pasar un err que no es un objeto y limpia uno plano", () => {
    const { logger, entries } = setup();

    logger.error({ err: "texto" }, "a");
    logger.error({ err: { code: "x", detail: "4.711" } }, "b");

    const [first, second] = entries();
    expect(first?.err).toBe("texto");
    expect(second?.err).toEqual({ code: "x" });
  });

  it.each([
    ["bajo una clave cualquiera", (e: Error) => ({ reason: e })],
    ["dentro de un arreglo", (e: Error) => ({ failures: [e] })],
    ["anidado bajo `err`", (e: Error) => ({ ctx: { err: e } })],
    ["anidado bajo otra clave", (e: Error) => ({ ctx: { inner: { cause: e } } })],
    ["en un arreglo de objetos", (e: Error) => ({ rejected: [{ eventId: "e-1", reason: e }] })],
  ])("un Error %s no filtra detail, where, internalQuery ni hint", (_caso, build) => {
    const lines: string[] = [];
    const logger = createLogger({ service: "s", destination: { write: (line) => void lines.push(line) } });

    logger.warn({ eventId: "e-1", ...build(pgError()) }, "a la DLQ");

    const raw = lines.join("");
    expect(raw).not.toMatch(/4\.711|-74\.07/);
    expect(raw).toContain("points_lat_check");
    expect(raw).toContain("new row violates check constraint");
  });

  it("serializa igual un Error bajo `reason` que bajo `err` (idempotente con el serializador de err)", () => {
    const { logger, entries } = setup();
    const error = pgError();

    logger.warn({ reason: error, err: error }, "x");

    const [entry] = entries();
    expect(entry?.reason).toEqual(entry?.err);
  });

  it("serializeError aplicado dos veces da lo mismo que una", () => {
    const once = serializeError(pgError());

    expect(serializeError(once)).toEqual(once);
  });

  it("redactDeep limpia un Error a cualquier profundidad", () => {
    const result = JSON.stringify(redactDeep({ a: [{ b: { c: pgError() } }] }));

    expect(result).not.toMatch(/4\.711|-74\.07/);
  });
});

describe("objetos que no son planos (URL, Buffer, Headers)", () => {
  it("un URL se escribe como origen y ruta, sin la query (que puede traer la posición)", () => {
    const lines: string[] = [];
    const logger = createLogger({ service: "s", destination: { write: (line) => void lines.push(line) } });

    logger.info({ target: new URL("http://fleet-api:4002/v1/vehicles?lat=4.711&lng=-74.072") }, "llamada");

    const raw = lines.join("");
    expect(raw).not.toMatch(/4\.711|74\.072|lat=/);
    expect(JSON.parse(raw)).toMatchObject({ target: "http://fleet-api:4002/v1/vehicles" });
  });

  it("un URL con credenciales no las escribe", () => {
    const lines: string[] = [];
    const logger = createLogger({ service: "s", destination: { write: (line) => void lines.push(line) } });

    logger.info({ target: new URL("http://user:S3CRET@fleet-api:4002/v1#frag") }, "llamada");

    expect(lines.join("")).not.toMatch(/S3CRET|user|frag/);
  });

  it("un URL anidado en un objeto y en un arreglo también", () => {
    const lines: string[] = [];
    const logger = createLogger({ service: "s", destination: { write: (line) => void lines.push(line) } });

    logger.info({ ctx: { urls: [new URL("http://a:1/p?lat=4.711")] } }, "x");

    expect(lines.join("")).not.toContain("4.711");
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ ctx: { urls: ["http://a:1/p"] } });
  });

  it("un Buffer y un Uint8Array se escriben como [binary N bytes], no su contenido", () => {
    const { logger, entries } = setup();

    logger.info({ raw: Buffer.from("lat=4.711"), view: new Uint8Array(3), data: new DataView(new ArrayBuffer(5)) }, "x");

    expect(entries()[0]).toMatchObject({ raw: "[binary 9 bytes]", view: "[binary 3 bytes]", data: "[binary 5 bytes]" });
  });

  it("un ArrayBuffer también", () => {
    const { logger, entries } = setup();

    logger.info({ buffer: new ArrayBuffer(4) }, "x");

    expect(entries()[0]).toMatchObject({ buffer: "[binary 4 bytes]" });
  });

  it("un Headers de undici no rompe el log ni escribe su contenido", () => {
    const lines: string[] = [];
    const logger = createLogger({ service: "s", destination: { write: (line) => void lines.push(line) } });

    logger.info({ headers: new Headers({ "x-trace": "abc" }) }, "x");

    expect(lines.join("")).not.toContain("unable to serialize");
  });
});
