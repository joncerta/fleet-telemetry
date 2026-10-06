import { apiErrorSchema, loginRequestSchema, sessionSchema } from "@fleet/contracts";
import { sha256Hex } from "@fleet/platform";
import { z } from "zod";
import { InvalidCredentialsError, SessionInvalidError } from "../../application/errors.js";
import type { GetSession } from "../../application/get-session.js";
import type { Login } from "../../application/login.js";
import type { FleetApiApp } from "./build-app.js";
import { clientIpKey } from "./client-ip.js";
import { HttpStatusError } from "./http-status-error.js";
import { identityOf, type SessionCookies } from "./session-auth.js";

export const LOGIN_PATH = "/v1/auth/login";
export const SESSION_PATH = "/v1/auth/session";
export const LOGOUT_PATH = "/v1/auth/logout";

/**
 * Fallos por key. `check` solo consulta; `recordFailure` cuenta un fallo. Lo implementa un adaptador en memoria
 * (`infrastructure/fixed-window-failure-counter.ts`).
 */
export interface FailureLimiter {
  check(key: string): { blocked: false } | { blocked: true; retryAfterSeconds: number };
  recordFailure(key: string): void;
}

export interface AuthRouteDependencies {
  login: Login;
  getSession: GetSession;
  cookies: SessionCookies;
  /** Fallos de login por IP (normalizada) y por correo (hasheado). Superado cualquiera de los dos: 429 con `Retry-After`. */
  loginLimits: { byIp: FailureLimiter; byEmail: FailureLimiter };
}

/** Key del contador por correo: el sha256 del correo en minúsculas. No guarda el correo (dato personal) ni crece con su largo. */
const emailKey = (email: string): string => sha256Hex(email.toLowerCase());

const errorResponses = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  413: apiErrorSchema,
  415: apiErrorSchema,
  429: apiErrorSchema,
  500: apiErrorSchema,
} as const;

/**
 * Sesión por cookie. Solo traduce: valida con el contrato, aplica los límites, delega en el caso de uso y deja la cookie.
 * - `POST /v1/auth/login`: límite de FALLOS por IP y por correo (se consulta ANTES de verificar la contraseña, que cuesta ~150 ms de
 *   scrypt, y se cuenta cada 401). Un 401 es genérico: no dice si el correo existe. Con éxito, cookie `fleet_session`.
 * - `GET /v1/auth/session`: la sesión de la cookie, o 401.
 * - `POST /v1/auth/logout`: borra la cookie (idempotente: sin cookie también responde 204).
 */
export function registerAuthRoutes(app: FleetApiApp, deps: AuthRouteDependencies): void {
  app.post(LOGIN_PATH, { schema: { body: loginRequestSchema, response: { 200: sessionSchema, ...errorResponses } } }, async (request, reply) => {
    const keys = [
      { limiter: deps.loginLimits.byIp, key: clientIpKey(request.ip) },
      { limiter: deps.loginLimits.byEmail, key: emailKey(request.body.email) },
    ];
    const blocked = keys.map(({ limiter, key }) => limiter.check(key)).filter((check) => check.blocked);
    if (blocked.length > 0) {
      const retryAfterSeconds = Math.max(...blocked.map((check) => check.retryAfterSeconds));
      void reply.header("retry-after", retryAfterSeconds);
      // Ni el correo ni la IP van al log: la línea de rechazo del error handler lleva solo el estado y el código.
      throw new HttpStatusError(429, "Demasiados intentos de inicio de sesión.");
    }

    try {
      const { identity, session } = await deps.login(request.body);
      deps.cookies.issue(reply, identity);
      request.log.info({ tenantId: identity.tenantId, userId: identity.userId }, "Inicio de sesión");
      return reply.code(200).send(session);
    } catch (error) {
      if (error instanceof InvalidCredentialsError) for (const { limiter, key } of keys) limiter.recordFailure(key);
      throw error;
    }
  });

  app.get(
    SESSION_PATH,
    { onRequest: deps.cookies.requireSession, schema: { response: { 200: sessionSchema, 401: apiErrorSchema, 429: apiErrorSchema, 500: apiErrorSchema } } },
    async (request, reply) => {
      try {
        return await deps.getSession(identityOf(request));
      } catch (error) {
        // El usuario de una cookie válida ya no existe: se borra la cookie para que el cliente no siga mandándola.
        if (error instanceof SessionInvalidError) deps.cookies.clear(reply);
        throw error;
      }
    },
  );

  app.post(LOGOUT_PATH, { schema: { response: { 204: z.null(), 429: apiErrorSchema, 500: apiErrorSchema } } }, async (_request, reply) => {
    deps.cookies.clear(reply);
    return reply.code(204).send(null);
  });
}
