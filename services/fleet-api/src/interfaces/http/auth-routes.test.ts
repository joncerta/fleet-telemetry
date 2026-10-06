import { randomUUID } from "node:crypto";
import { apiErrorSchema, sessionSchema } from "@fleet/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InvalidCredentialsError, SessionInvalidError } from "../../application/errors.js";
import type { Login } from "../../application/login.js";
import { NORTE, SESSION, makeTestApp, type TestAppOptions } from "../../testing/test-app.js";
import type { FleetApiApp } from "./build-app.js";
import { SESSION_COOKIE_NAME } from "./session-auth.js";

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

const login = (app: FleetApiApp, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: "/v1/auth/login", payload: payload as object, headers });

const CREDENTIALS = { email: "operador@norte.test", password: "una-contraseña" };

/** El valor `fleet_session` de un `Set-Cookie`, o undefined. */
const setCookieOf = (response: { headers: Record<string, unknown> }): string | undefined => {
  const header = response.headers["set-cookie"];
  const list = Array.isArray(header) ? header : typeof header === "string" ? [header] : [];
  return list.find((cookie): cookie is string => typeof cookie === "string" && cookie.startsWith(`${SESSION_COOKIE_NAME}=`));
};

describe("POST /v1/auth/login", () => {
  it("con credenciales correctas responde 200 con la sesión del contrato y la cookie fleet_session HttpOnly, SameSite=Lax y Path=/", async () => {
    const { app, codec } = await makeApp();

    const response = await login(app, CREDENTIALS);

    expect(response.statusCode).toBe(200);
    expect(sessionSchema.parse(response.json())).toEqual(SESSION);
    const cookie = setCookieOf(response) ?? "";
    expect(cookie).toMatch(/; HttpOnly/i);
    expect(cookie).toMatch(/; SameSite=Lax/i);
    expect(cookie).toMatch(/; Path=\//);
    expect(cookie).toMatch(/; Max-Age=3600/);
    expect(cookie).not.toMatch(/; Secure/i);
    // El valor es un token firmado con la identidad verificada, y vence en la hora configurada.
    const token = cookie.slice(`${SESSION_COOKIE_NAME}=`.length).split(";", 1)[0] ?? "";
    expect(codec.verify(token)).toMatchObject({ userId: NORTE.userId, tenantId: NORTE.tenantId });
  });

  it("la cookie lleva Secure cuando FLEET_API_COOKIE_SECURE es true", async () => {
    const { app } = await makeApp({ secureCookie: true });

    expect(setCookieOf(await login(app, CREDENTIALS))).toMatch(/; Secure/i);
  });

  it("la sesión no cabe en el JSON junto con la cookie ni la repite: el cuerpo no contiene el token", async () => {
    const { app } = await makeApp();

    const response = await login(app, CREDENTIALS);

    const cookie = setCookieOf(response) ?? "";
    const token = cookie.slice(`${SESSION_COOKIE_NAME}=`.length).split(";", 1)[0] ?? "";
    expect(response.body).not.toContain(token);
  });

  it("credenciales malas responden 401 genérico, sin cookie, y no dicen si el correo existe", async () => {
    const { app } = await makeApp({ useCases: { login: () => Promise.reject(new InvalidCredentialsError()) } });

    const response = await login(app, { email: "nadie@norte.test", password: "x" });

    expect(response.statusCode).toBe(401);
    expect(apiErrorSchema.parse(response.json())).toEqual({ error: { code: "unauthorized", message: "Credenciales ausentes o inválidas." } });
    expect(setCookieOf(response)).toBeUndefined();
    expect(response.body).not.toContain("nadie@norte.test");
  });

  it("un cuerpo inválido (correo mal formado, sin contraseña, campos de más) responde 400", async () => {
    const { app, useCases } = await makeApp();

    for (const payload of [{ email: "no-es-correo", password: "x" }, { email: "a@b.test" }, {}, { email: 5, password: "x" }]) {
      expect((await login(app, payload)).statusCode).toBe(400);
    }
    expect(useCases.login).not.toHaveBeenCalled();
  });

  it("después de N fallos desde la misma IP responde 429 con Retry-After SIN llamar al caso de uso (no gasta scrypt)", async () => {
    const failingLogin = vi.fn<Login>(() => Promise.reject(new InvalidCredentialsError()));
    const { app } = await makeApp({ useCases: { login: failingLogin }, loginLimit: { max: 2, timeWindowMs: 60_000 } });
    const ip = { "x-forwarded-for": "198.51.100.10" };

    expect((await login(app, { ...CREDENTIALS, email: "a@norte.test" }, ip)).statusCode).toBe(401);
    expect((await login(app, { ...CREDENTIALS, email: "b@norte.test" }, ip)).statusCode).toBe(401);
    const blocked = await login(app, { ...CREDENTIALS, email: "c@norte.test" }, ip);

    expect(blocked.statusCode).toBe(429);
    expect(apiErrorSchema.parse(blocked.json()).error.code).toBe("rate_limited");
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect(failingLogin).toHaveBeenCalledTimes(2);
  });

  it("el límite por IP no alcanza a otra IP", async () => {
    const { app } = await makeApp({ useCases: { login: () => Promise.reject(new InvalidCredentialsError()) }, loginLimit: { max: 1, timeWindowMs: 60_000 } });

    await login(app, { ...CREDENTIALS, email: "a@norte.test" }, { "x-forwarded-for": "198.51.100.10" });

    expect((await login(app, { ...CREDENTIALS, email: "b@norte.test" }, { "x-forwarded-for": "198.51.100.10" })).statusCode).toBe(429);
    expect((await login(app, { ...CREDENTIALS, email: "c@norte.test" }, { "x-forwarded-for": "198.51.100.20" })).statusCode).toBe(401);
  });

  it("el límite por correo bloquea ese correo desde cualquier IP, sin distinguir mayúsculas, y no a otros correos", async () => {
    const { app } = await makeApp({ useCases: { login: () => Promise.reject(new InvalidCredentialsError()) }, loginLimit: { max: 2, timeWindowMs: 60_000 } });

    await login(app, { ...CREDENTIALS, email: "Victima@Norte.Test" }, { "x-forwarded-for": "198.51.100.1" });
    await login(app, { ...CREDENTIALS, email: "victima@norte.test" }, { "x-forwarded-for": "198.51.100.2" });

    expect((await login(app, { ...CREDENTIALS, email: "VICTIMA@NORTE.TEST" }, { "x-forwarded-for": "198.51.100.3" })).statusCode).toBe(429);
    expect((await login(app, { ...CREDENTIALS, email: "otra@norte.test" }, { "x-forwarded-for": "198.51.100.4" })).statusCode).toBe(401);
  });

  it("un login correcto no cuenta como fallo", async () => {
    const { app } = await makeApp({ loginLimit: { max: 1, timeWindowMs: 60_000 } });

    for (let i = 0; i < 4; i++) expect((await login(app, CREDENTIALS)).statusCode).toBe(200);
  });

  it("ni el correo, ni la contraseña, ni el token ni la IP van a los logs", async () => {
    const { app, raw } = await makeApp({
      useCases: { login: (request) => (request.email === "secreto@norte.test" ? Promise.reject(new InvalidCredentialsError()) : Promise.resolve({ identity: NORTE, session: SESSION })) },
    });

    await login(app, { email: "secreto@norte.test", password: "contraseña-secreta" }, { "x-forwarded-for": "203.0.113.77" });
    await login(app, CREDENTIALS);

    for (const forbidden of ["secreto@norte.test", "contraseña-secreta", "203.0.113.77", "operador@norte.test", "una-contraseña", "Operador Norte"]) {
      expect(raw()).not.toContain(forbidden);
    }
  });

  it("un fallo inesperado de la base responde 500 genérico, no 401", async () => {
    const { app } = await makeApp({ useCases: { login: () => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:5432")) } });

    const response = await login(app, CREDENTIALS);

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toMatch(/ECONNREFUSED|5432/);
  });
});

describe("GET /v1/auth/session", () => {
  it("con una cookie válida responde la sesión del contrato, pidiéndola para la identidad de la cookie", async () => {
    const { app, useCases, sessionCookieOf } = await makeApp();

    const response = await app.inject({ method: "GET", url: "/v1/auth/session", headers: { cookie: sessionCookieOf(NORTE) } });

    expect(response.statusCode).toBe(200);
    expect(sessionSchema.parse(response.json())).toEqual(SESSION);
    expect(useCases.getSession).toHaveBeenCalledExactlyOnceWith(NORTE);
  });

  it.each([
    ["sin cookie", undefined],
    ["con una cookie basura", `${SESSION_COOKIE_NAME}=basura`],
    ["con una cookie de otro nombre", "otra=v1.a.b"],
  ])("%s responde 401", async (_label, cookie) => {
    const { app, useCases } = await makeApp();

    const response = await app.inject({ method: "GET", url: "/v1/auth/session", ...(cookie !== undefined && { headers: { cookie } }) });

    expect(response.statusCode).toBe(401);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe("unauthorized");
    expect(useCases.getSession).not.toHaveBeenCalled();
  });

  it("una cookie vencida responde 401", async () => {
    const { app, sessionCookieOf } = await makeApp();

    const response = await app.inject({ method: "GET", url: "/v1/auth/session", headers: { cookie: sessionCookieOf(NORTE, Math.floor(Date.now() / 1_000) - 1) } });

    expect(response.statusCode).toBe(401);
  });

  it("una cookie con la firma alterada responde 401", async () => {
    const { app, codec } = await makeApp();
    const token = codec.sign({ ...NORTE, exp: Math.floor(Date.now() / 1_000) + 600 });
    // Se invierte un byte de la firma YA decodificada: alterar el último carácter de base64url aporta solo 4 bits y a veces decodifica igual.
    const [version, payload, signature] = token.split(".");
    const bytes = Buffer.from(signature ?? "", "base64url");
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    const tampered = `${version}.${payload}.${bytes.toString("base64url")}`;
    expect(tampered).not.toBe(token);
    const forged = `${SESSION_COOKIE_NAME}=${tampered}`;

    expect((await app.inject({ method: "GET", url: "/v1/auth/session", headers: { cookie: forged } })).statusCode).toBe(401);
  });

  it("si el usuario de una cookie válida ya no existe responde 401 y borra la cookie", async () => {
    const { app, sessionCookieOf } = await makeApp({ useCases: { getSession: () => Promise.reject(new SessionInvalidError()) } });

    const response = await app.inject({ method: "GET", url: "/v1/auth/session", headers: { cookie: sessionCookieOf(NORTE) } });

    expect(response.statusCode).toBe(401);
    expect(setCookieOf(response)).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/);
  });

  it("no acepta la identidad por otro camino: un tenantId en la query o en un header no cambia la identidad de la cookie", async () => {
    const { app, useCases, sessionCookieOf } = await makeApp();

    await app.inject({
      method: "GET",
      url: `/v1/auth/session?tenantId=${randomUUID()}`,
      headers: { cookie: sessionCookieOf(NORTE), "x-tenant-id": randomUUID() },
    });

    expect(useCases.getSession).toHaveBeenCalledExactlyOnceWith(NORTE);
  });
});

describe("POST /v1/auth/logout", () => {
  it("responde 204 y borra la cookie con los mismos atributos", async () => {
    const { app, sessionCookieOf } = await makeApp();

    const response = await app.inject({ method: "POST", url: "/v1/auth/logout", headers: { cookie: sessionCookieOf(NORTE) } });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    const cookie = setCookieOf(response) ?? "";
    expect(cookie).toMatch(/^fleet_session=;/);
    expect(cookie).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/);
    expect(cookie).toMatch(/; Path=\//);
    expect(cookie).toMatch(/; HttpOnly/i);
  });

  it("es idempotente: sin cookie también responde 204", async () => {
    const { app } = await makeApp();

    expect((await app.inject({ method: "POST", url: "/v1/auth/logout" })).statusCode).toBe(204);
  });
});
