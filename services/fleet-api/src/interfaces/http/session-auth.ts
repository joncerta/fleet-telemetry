import type { SessionCodec } from "@fleet/platform";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuthIdentity } from "../../domain/identity.js";
import { HttpStatusError } from "./http-status-error.js";

declare module "fastify" {
  interface FastifyRequest {
    /**
     * Identidad VERIFICADA de la sesión (`null` hasta que `requireSession` la fija). El `tenantId` de toda consulta sale de aquí, nunca del
     * body, la query ni un argumento: regla 4.
     */
    auth: AuthIdentity | null;
  }
}

/** Nombre de la cookie de sesión. Es `HttpOnly`: el cliente nunca la lee. */
export const SESSION_COOKIE_NAME = "fleet_session";

export interface SessionCookieSettings {
  /** Códec de la plataforma con `SESSION_SECRET`. */
  codec: SessionCodec;
  /** Vida de la sesión desde el login, en segundos. */
  ttlSeconds: number;
  /** Atributo `Secure`: false solo en local (http). */
  secure: boolean;
  /** Reloj en ms, para los tests. */
  now?: () => number;
}

export interface SessionCookies {
  /** Firma la identidad y deja la cookie en la respuesta. */
  issue(reply: FastifyReply, identity: AuthIdentity): void;
  /** Borra la cookie del navegador. */
  clear(reply: FastifyReply): void;
  /** Identidad de una cookie firmada y vigente, o `undefined` por cualquier otra razón. */
  identityOf(request: FastifyRequest): AuthIdentity | undefined;
  /**
   * `onRequest` de las rutas con sesión: verifica la cookie y deja `request.auth = { userId, tenantId }`, o corta con 401 (el mismo para
   * "sin cookie", "firma inválida" y "vencida"). Corre antes de leer el cuerpo.
   */
  requireSession: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

/** Atributos de la cookie: iguales al emitirla y al borrarla (el navegador solo borra la que coincide en ruta y dominio). */
const baseOptions = (secure: boolean) => ({ path: "/", httpOnly: true, sameSite: "lax", secure }) as const;

/**
 * Cookie de sesión `fleet_session`: `HttpOnly`, `SameSite=Lax`, `Path=/` y `Secure` según la configuración. El valor es el token del
 * códec (HMAC-SHA256, ver `createSessionCodec` en @fleet/platform); aquí solo se lee y se escribe.
 */
export function createSessionCookies(settings: SessionCookieSettings): SessionCookies {
  const now = settings.now ?? Date.now;

  const identityOf = (request: FastifyRequest): AuthIdentity | undefined => {
    const token = request.cookies[SESSION_COOKIE_NAME];
    if (token === undefined || token === "") return undefined;
    const claims = settings.codec.verify(token, now());
    return claims === undefined ? undefined : { userId: claims.userId, tenantId: claims.tenantId };
  };

  return {
    issue(reply, identity) {
      const exp = Math.floor(now() / 1_000) + settings.ttlSeconds;
      const token = settings.codec.sign({ userId: identity.userId, tenantId: identity.tenantId, exp });
      void reply.setCookie(SESSION_COOKIE_NAME, token, { ...baseOptions(settings.secure), maxAge: settings.ttlSeconds });
    },

    clear(reply) {
      void reply.clearCookie(SESSION_COOKIE_NAME, baseOptions(settings.secure));
    },

    identityOf,

    requireSession(request) {
      const identity = identityOf(request);
      if (identity === undefined) throw new HttpStatusError(401, "Sesión ausente, inválida o vencida.");
      request.auth = identity;
      return Promise.resolve();
    },
  };
}

/** Identidad de una petición ya autenticada. Inalcanzable sin ella: `requireSession` corta antes; se comprueba por si alguien cambia los hooks. */
export function identityOf(request: FastifyRequest): AuthIdentity {
  if (request.auth === null) throw new HttpStatusError(401, "Petición sin identidad verificada.");
  return request.auth;
}
