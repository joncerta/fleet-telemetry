import { randomUUID } from "node:crypto";
import { apiErrorSchema, zoneFeatureSchema, ZONE_MAX_VERTICES } from "@fleet/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { InvalidZoneGeometryError, ZoneLimitReachedError, ZoneNameTakenError } from "../../application/errors.js";
import { CREATED_ZONE, makeTestApp, NORTE, type TestAppOptions } from "../../testing/test-app.js";
import type { FleetApiApp } from "./build-app.js";

let current: FleetApiApp | undefined;

afterEach(async () => {
  await current?.close();
  current = undefined;
});

async function makeApp(options: TestAppOptions = {}) {
  const made = await makeTestApp(options);
  current = made.app;
  return made;
}

const ring = [
  [-74.08, 4.7],
  [-74.07, 4.7],
  [-74.07, 4.71],
  [-74.08, 4.71],
  [-74.08, 4.7],
];
const valid = (extra: Record<string, unknown> = {}) => ({ name: "  Zona crítica Norte  ", kind: "critical", geometry: { type: "Polygon", coordinates: [ring] }, ...extra });

const post = (app: FleetApiApp, payload: unknown, cookie?: string) =>
  app.inject({ method: "POST", url: "/v1/zones", payload: payload as object, ...(cookie !== undefined && { headers: { cookie } }) });

describe("POST /v1/zones", () => {
  it("con sesión responde 201 con el Feature, creándolo para la identidad de la SESIÓN con el nombre recortado", async () => {
    const { app, useCases, sessionCookieOf } = await makeApp();

    const response = await post(app, valid(), sessionCookieOf(NORTE));

    expect(response.statusCode).toBe(201);
    expect(zoneFeatureSchema.parse(response.json())).toEqual(CREATED_ZONE);
    expect(useCases.createZone).toHaveBeenCalledExactlyOnceWith({
      identity: NORTE,
      zone: { name: "Zona crítica Norte", kind: "critical", geometry: { type: "Polygon", coordinates: [ring] } },
    });
  });

  it("ignora un tenantId o un zoneId del cuerpo: la identidad es la de la sesión y el id lo decide el servidor", async () => {
    const { app, useCases, sessionCookieOf } = await makeApp();

    await post(app, valid({ tenantId: randomUUID(), zoneId: randomUUID() }), sessionCookieOf(NORTE));

    expect(useCases.createZone).toHaveBeenCalledExactlyOnceWith({
      identity: NORTE,
      zone: { name: "Zona crítica Norte", kind: "critical", geometry: { type: "Polygon", coordinates: [ring] } },
    });
  });

  it("sin sesión responde 401 sin llegar al caso de uso", async () => {
    const { app, useCases } = await makeApp();

    const response = await post(app, valid());

    expect(response.statusCode).toBe(401);
    expect(useCases.createZone).not.toHaveBeenCalled();
  });

  it("un nombre repetido responde 409 zone_name_taken, sin el nombre en la respuesta ni en los logs", async () => {
    const { app, raw, sessionCookieOf } = await makeApp({ useCases: { createZone: () => Promise.reject(new ZoneNameTakenError()) } });

    const response = await post(app, valid({ name: "Nombre Secreto" }), sessionCookieOf(NORTE));

    expect(response.statusCode).toBe(409);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe("zone_name_taken");
    expect(response.body).not.toContain("Nombre Secreto");
    expect(raw()).not.toContain("Nombre Secreto");
  });

  it("un tenant con el máximo de zonas responde 409 zone_limit_reached", async () => {
    const { app, sessionCookieOf } = await makeApp({ useCases: { createZone: () => Promise.reject(new ZoneLimitReachedError()) } });

    const response = await post(app, valid(), sessionCookieOf(NORTE));

    expect(response.statusCode).toBe(409);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe("zone_limit_reached");
  });

  it("200 vértices en precisión double completa caben en el límite de cuerpo (16 KiB): responde 201, no 413", async () => {
    const { app, useCases, sessionCookieOf } = await makeApp();
    const points = Array.from({ length: ZONE_MAX_VERTICES }, (_, i) => {
      const angle = (2 * Math.PI * i) / ZONE_MAX_VERTICES;
      return [-74.01234567890123 + 0.0512345678901234 * Math.cos(angle), 4.712345678901234 + 0.0512345678901234 * Math.sin(angle)];
    });
    const payload = valid({ geometry: { type: "Polygon", coordinates: [[...points, points[0]]] } });
    expect(JSON.stringify(payload).length).toBeGreaterThan(7_000);

    const response = await post(app, payload, sessionCookieOf(NORTE));

    expect(response.statusCode).toBe(201);
    expect(useCases.createZone).toHaveBeenCalledOnce();
  });

  it("un polígono que PostGIS rechaza responde 400 invalid_geometry, sin 500", async () => {
    const { app, sessionCookieOf } = await makeApp({ useCases: { createZone: () => Promise.reject(new InvalidZoneGeometryError()) } });

    const response = await post(app, valid(), sessionCookieOf(NORTE));

    expect(response.statusCode).toBe(400);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe("invalid_geometry");
  });

  it("un fallo inesperado responde 500 internal_error sin detalle", async () => {
    const { app, sessionCookieOf } = await makeApp({ useCases: { createZone: () => Promise.reject(new Error('relation "zones" does not exist')) } });

    const response = await post(app, valid(), sessionCookieOf(NORTE));

    expect(response.statusCode).toBe(500);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe("internal_error");
    expect(response.body).not.toContain("relation");
  });

  const tooMany = Array.from({ length: ZONE_MAX_VERTICES + 1 }, (_, i) => [-74 + 0.0001 * i, 4.7 + 0.0001 * (i % 2)]);
  it.each([
    ["sin cuerpo", {}],
    ["anillo abierto", valid({ geometry: { type: "Polygon", coordinates: [ring.slice(0, 4)] } })],
    ["menos de 4 posiciones", valid({ geometry: { type: "Polygon", coordinates: [ring.slice(0, 3)] } })],
    ["más de 200 vértices", valid({ geometry: { type: "Polygon", coordinates: [[...tooMany, tooMany[0]]] } })],
    ["fuera de Colombia", valid({ geometry: { type: "Polygon", coordinates: [ring.map(([lng, lat]) => [lng, (lat ?? 0) + 40])] } })],
    ["lat y lon invertidos", valid({ geometry: { type: "Polygon", coordinates: [ring.map(([lng, lat]) => [lat, lng])] } })],
    ["con hueco", valid({ geometry: { type: "Polygon", coordinates: [ring, ring] } })],
    ["no es Polygon", valid({ geometry: { type: "Point", coordinates: [-74, 4.7] } })],
    ["tipo desconocido", valid({ kind: "warehouse" })],
    ["nombre vacío", valid({ name: "   " })],
    ["nombre largo", valid({ name: "a".repeat(81) })],
    ["nombre con NUL", valid({ name: `a${String.fromCharCode(0)}b` })],
    ["nombre con bidi", valid({ name: `${String.fromCharCode(0x202e)}abc` })],
    ["nombre solo de U+200B", valid({ name: String.fromCharCode(0x200b).repeat(3) })],
  ])("un cuerpo inválido (%s) responde 400 invalid_request sin llegar al caso de uso", async (_label, payload) => {
    const { app, useCases, sessionCookieOf } = await makeApp();

    const response = await post(app, payload, sessionCookieOf(NORTE));

    expect(response.statusCode).toBe(400);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe("invalid_request");
    expect(useCases.createZone).not.toHaveBeenCalled();
  });

  // Anti-CSRF: un formulario de otro sitio solo puede enviar estos tipos (o ninguno) sin preflight de CORS.
  it.each(["application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "text/plain", undefined])(
    "un POST con cookie y content-type %s responde 415 sin llegar al caso de uso",
    async (contentType) => {
      const { app, useCases, sessionCookieOf } = await makeApp();

      const response = await app.inject({
        method: "POST",
        url: "/v1/zones",
        payload: "name=Zona",
        headers: { cookie: sessionCookieOf(NORTE), ...(contentType !== undefined && { "content-type": contentType }) },
      });

      expect(response.statusCode).toBe(415);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe("unsupported_media_type");
      expect(useCases.createZone).not.toHaveBeenCalled();
    },
  );

  it("sin sesión, el tercer POST desde la misma IP responde 429 y otra IP no se ve afectada", async () => {
    const { app, useCases } = await makeApp({ createZoneLimit: { max: 2, timeWindowMs: 60_000 } });
    const from = (ip: string) => app.inject({ method: "POST", url: "/v1/zones", payload: valid(), headers: { "x-forwarded-for": ip } });

    expect((await from("192.0.2.1")).statusCode).toBe(401);
    expect((await from("192.0.2.1")).statusCode).toBe(401);
    const blocked = await from("192.0.2.1");

    expect(blocked.statusCode).toBe(429);
    expect(apiErrorSchema.parse(blocked.json()).error.code).toBe("rate_limited");
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect((await from("192.0.2.2")).statusCode).toBe(401);
    expect(useCases.createZone).not.toHaveBeenCalled();
  });

  it("el límite de altas es por usuario: al superarlo, 429 con Retry-After, y otro usuario no se ve afectado", async () => {
    const { app, useCases, sessionCookieOf } = await makeApp({ createZoneLimit: { max: 2, timeWindowMs: 60_000 } });
    const other = { userId: randomUUID(), tenantId: randomUUID() };

    expect((await post(app, valid(), sessionCookieOf(NORTE))).statusCode).toBe(201);
    expect((await post(app, valid(), sessionCookieOf(NORTE))).statusCode).toBe(201);
    const blocked = await post(app, valid(), sessionCookieOf(NORTE));

    expect(blocked.statusCode).toBe(429);
    expect(apiErrorSchema.parse(blocked.json()).error.code).toBe("rate_limited");
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect(useCases.createZone).toHaveBeenCalledTimes(2);
    expect((await post(app, valid(), sessionCookieOf(other))).statusCode).toBe(201);
  });

  it("ni el nombre ni el polígono pasan por los logs; la línea lleva solo identificadores", async () => {
    const { app, raw, logged, sessionCookieOf } = await makeApp();

    await post(app, valid({ name: "Nombre Secreto" }), sessionCookieOf(NORTE));

    expect(raw()).not.toContain("Nombre Secreto");
    expect(raw()).not.toContain("-74.08");
    const line = logged().find((entry) => entry.msg === "Zona creada");
    expect(line).toMatchObject({ tenantId: NORTE.tenantId, userId: NORTE.userId, zoneId: CREATED_ZONE.properties.zoneId });
  });
});
