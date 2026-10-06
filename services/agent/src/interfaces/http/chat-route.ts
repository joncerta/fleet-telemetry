import { apiErrorSchema, chatRequestSchema, chatResponseSchema } from "@fleet/contracts";
import type { Chat } from "../../application/chat.js";
import type { RateLimitSettings, AgentApp } from "./build-app.js";
import { sessionOfRequest, type SessionAuth } from "./session-auth.js";

export const CHAT_PATH = "/v1/chat";

export interface ChatRouteDependencies {
  auth: SessionAuth;
  chat: Chat;
  /** Preguntas por usuario y ventana: cada una cuesta una llamada al modelo. */
  userRateLimit: RateLimitSettings;
}

const errorResponses = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  413: apiErrorSchema,
  415: apiErrorSchema,
  429: apiErrorSchema,
  500: apiErrorSchema,
  503: apiErrorSchema,
  504: apiErrorSchema,
} as const;

/**
 * `POST /v1/chat`. Solo traduce: la sesión (`preValidation`, antes de validar el cuerpo) fija la identidad, el cuerpo se valida con el
 * contrato, el caso de uso recibe la identidad de la SESIÓN (nunca del cuerpo) y la respuesta se serializa con su esquema.
 *
 * El rate limit es POR USUARIO (la identidad de la cookie verificada; sin sesión válida, por IP) y corre antes que la autenticación: la
 * clave se calcula verificando la cookie, que es una comparación de HMAC y no toca fleet-api ni el modelo. Así un 401 también cuenta.
 *
 * Los logs llevan solo conteos, nombres de herramienta y duración: nunca la pregunta ni la respuesta, que pueden mencionar placas.
 */
export function registerChatRoute(app: AgentApp, deps: ChatRouteDependencies): void {
  app.post(
    CHAT_PATH,
    {
      // `preValidation` y no `onRequest`: el límite de abajo es un hook `onRequest` que el plugin añade DESPUÉS de los `onRequest` de la ruta, y
      // tiene que correr antes de la autenticación para que las peticiones sin sesión también cuenten (por IP).
      preValidation: deps.auth.requireSession,
      config: {
        rateLimit: {
          max: deps.userRateLimit.max,
          timeWindow: deps.userRateLimit.timeWindowMs,
          keyGenerator: (request) => {
            const session = deps.auth.sessionOf(request);
            return session === undefined ? `ip:${request.ip}` : `user:${session.identity.userId}`;
          },
        },
      },
      schema: { body: chatRequestSchema, response: { 200: chatResponseSchema, ...errorResponses } },
    },
    async (request) => {
      const session = sessionOfRequest(request);
      const startedAt = performance.now();

      const response = await deps.chat({
        context: { identity: session.identity, sessionToken: session.sessionToken, correlationId: request.id },
        message: request.body.message,
      });

      request.log.info(
        {
          tenantId: session.identity.tenantId,
          toolCalls: response.toolCalls.length,
          tools: response.toolCalls.map((call) => `${call.name}:${call.status}`),
          breaker: response.breaker.state,
          durationMs: Math.round(performance.now() - startedAt),
        },
        "Pregunta respondida",
      );
      return response;
    },
  );
}
