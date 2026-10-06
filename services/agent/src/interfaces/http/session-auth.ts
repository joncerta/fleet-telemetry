import type { SessionCodec } from "@fleet/platform";
import type { FastifyRequest } from "fastify";
import type { AgentIdentity } from "../../domain/identity.js";
import { SESSION_COOKIE_NAME } from "../../domain/protocol.js";
import { HttpStatusError } from "./http-status-error.js";

/** Sesión VERIFICADA de la petición: quién es y el token firmado que se reenvía a fleet-api. */
export interface AgentSession {
  readonly identity: AgentIdentity;
  /** Token de la cookie `fleet_session`, ya verificado. Es un secreto: no va a logs ni a respuestas. */
  readonly sessionToken: string;
}

declare module "fastify" {
  interface FastifyRequest {
    /**
     * Sesión VERIFICADA (`null` hasta que `requireSession` la fija). El `tenantId` de toda consulta sale de aquí, nunca del body, la
     * query ni un argumento del LLM: reglas 4 y 10.
     */
    auth: AgentSession | null;
  }
}

export interface SessionAuthSettings {
  /** Códec de la plataforma con el `SESSION_SECRET` de fleet-api. */
  codec: SessionCodec;
  /** Reloj en ms, para los tests. */
  now?: () => number;
}

export interface SessionAuth {
  /** La sesión de una cookie firmada y vigente, o `undefined` por cualquier otra razón. No lanza. */
  sessionOf(request: FastifyRequest): AgentSession | undefined;
  /** `onRequest` de las rutas con sesión: verifica la cookie y deja `request.auth`, o corta con 401 (el mismo para todo motivo). */
  requireSession: (request: FastifyRequest) => Promise<void>;
}

/**
 * Valida la cookie `fleet_session` que emitió fleet-api, con el mismo códec (HMAC-SHA256). El agente NUNCA emite sesiones: solo las
 * lee. Un token ausente, mal firmado o vencido es el mismo 401.
 */
export function createSessionAuth(settings: SessionAuthSettings): SessionAuth {
  const now = settings.now ?? Date.now;

  const sessionOf = (request: FastifyRequest): AgentSession | undefined => {
    const token = request.cookies[SESSION_COOKIE_NAME];
    if (token === undefined || token === "") return undefined;
    const claims = settings.codec.verify(token, now());
    return claims === undefined ? undefined : { identity: { userId: claims.userId, tenantId: claims.tenantId }, sessionToken: token };
  };

  return {
    sessionOf,
    requireSession(request) {
      const session = sessionOf(request);
      if (session === undefined) throw new HttpStatusError(401, "Sesión ausente, inválida o vencida.");
      request.auth = session;
      return Promise.resolve();
    },
  };
}

/** Sesión de una petición ya autenticada. Inalcanzable sin ella: `requireSession` corta antes; se comprueba por si alguien cambia los hooks. */
export function sessionOfRequest(request: FastifyRequest): AgentSession {
  if (request.auth === null) throw new HttpStatusError(401, "Petición sin identidad verificada.");
  return request.auth;
}
