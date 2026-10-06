import type { IncomingMessage, ServerResponse } from "node:http";
import type { HealthResponse } from "@fleet/contracts";
import rateLimit from "@fastify/rate-limit";
import type { Logger } from "@fleet/platform";
import Fastify, { LogController, type FastifyInstance, type FastifyRequest, type RawServerDefault } from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { CORRELATION_ID_HTTP_HEADER, resolveCorrelationId } from "./correlation.js";
import { mapError, notFoundError } from "./errors.js";
import { registerHealthRoute } from "./health-route.js";

/** App de Fastify con el type provider de zod: el tipo de las rutas sale de sus esquemas. */
export type GatewayApp = FastifyInstance<RawServerDefault, IncomingMessage, ServerResponse, Logger, ZodTypeProvider>;

export interface RateLimitSettings {
  /** Peticiones permitidas por ventana y por key. */
  max: number;
  timeWindowMs: number;
  /**
   * Key del contador. Sin ella, la IP del cliente (`request.ip`, que respeta `trustProxyHops`): es el tope por IP contra
   * floods, que corre ANTES de autenticar y cuenta todo. Ni el límite por dispositivo ni el de fallos de autenticación pasan
   * por aquí: los aplica la ruta de la ingesta (ver `registerTelemetryRoute`).
   */
  keyGenerator?: (request: FastifyRequest) => string;
  /** Fase del ciclo de vida en que se cuenta. Por defecto `onRequest` (antes de leer el cuerpo). */
  hook?: "onRequest" | "preParsing" | "preValidation" | "preHandler";
}

export interface AppDependencies {
  /** Logger del proceso (plataforma). Cada petición loguea con un hijo que lleva su `correlationId`. */
  logger: Logger;
  /**
   * Saltos de proxy de confianza delante del servicio (el ALB = 1); 0 o ausente los desactiva y `request.ip` es la de la
   * conexión. Con N > 0 la IP del cliente es la que añadió el N-ésimo proxy de confianza en `X-Forwarded-For`; lo que el
   * cliente antepone se ignora. Mal configurado, el límite por IP se vuelve global (la IP del balanceador) o se deja falsear.
   */
  trustProxyHops?: number;
  /** Tope del cuerpo en bytes. Superarlo responde `413 payload_too_large`. */
  bodyLimitBytes: number;
  /** Tope ALTO por IP contra floods: cuenta todas las peticiones. El límite contra la fuerza bruta de tokens está en la ruta. */
  rateLimit: RateLimitSettings;
  /** Caso de uso de `GET /health`. */
  checkHealth: () => Promise<HealthResponse>;
  /** Rutas de los casos de uso. Se registran después del rate limit, para que las cubra. */
  registerRoutes?: (app: GatewayApp) => void | Promise<void>;
}

/**
 * `trustProxy` por número de saltos. NO se le pasa el número a Fastify: desde 5.12 `trustProxy: <number>` falla en cerrado
 * (siempre "no confiar", y `X-Forwarded-For` se ignora) porque un conteo de saltos no puede validar al par inmediato. Una
 * función `(dirección, salto) => salto < n` sí da la semántica documentada del conteo. Su riesgo es el que Fastify advierte:
 * si el servicio fuera alcanzable sin pasar por el proxy, un cliente podría falsear su IP; por eso el balanceador debe ser la
 * única entrada (grupo de seguridad), ver ADR-004.
 */
const trustFirstHops =
  (hops: number) =>
  (_address: string, hop: number): boolean =>
    hop < hops;

/** Ruta sin la query: la URL de una petición no debe arrastrar al log lo que el cliente haya puesto ahí. */
const pathOf = (url: string): string => url.split("?", 1)[0] ?? "";

/**
 * Arma la app de Fastify. Es una fábrica sin efectos globales (no escucha ni lee el entorno): los tests la usan con
 * `app.inject`, y `main.ts` la pone a escuchar.
 *
 * - `request.id` ES el `correlationId`: viene del header `x-correlation-id` si es válido o se genera, sale en la
 *   respuesta con el mismo header y en cada línea de `request.log` como `correlationId`.
 * - Los logs de petición llevan método, ruta y estado; nunca IP, headers, query ni cuerpo.
 * - Todo error sale como `apiErrorSchema` (ver `mapError`), sin stack, SQL ni datos personales.
 */
export async function buildApp(deps: AppDependencies): Promise<GatewayApp> {
  const requestLogger = deps.logger.child(
    {},
    {
      serializers: {
        req: (request: FastifyRequest) => ({ method: request.method, url: pathOf(request.url) }),
        res: (reply: { statusCode: number }) => ({ statusCode: reply.statusCode }),
      },
    },
  );

  const app: GatewayApp = Fastify({
    loggerInstance: requestLogger,
    bodyLimit: deps.bodyLimitBytes,
    ...(deps.trustProxyHops !== undefined && deps.trustProxyHops > 0 && { trustProxy: trustFirstHops(deps.trustProxyHops) }),
    // El id lo decide `genReqId` (con validación); sin esto Fastify tomaría el header sin validar.
    requestIdHeader: false,
    logController: new LogController({ requestIdLogLabel: "correlationId" }),
    genReqId: (request) => resolveCorrelationId(request.headers[CORRELATION_ID_HTTP_HEADER]),
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Fastify parsea `text/plain` además de JSON por defecto. La API es solo `application/json`: cualquier otro tipo
  // (con cuerpo) responde `415 unsupported_media_type`.
  app.removeContentTypeParser("text/plain");

  // Antes del rate limit: hasta una respuesta 429 lleva el correlationId.
  app.addHook("onRequest", (request, reply, done) => {
    void reply.header(CORRELATION_ID_HTTP_HEADER, request.id);
    done();
  });

  app.setErrorHandler((error, request, reply) => {
    const mapped = mapError(error);
    if (mapped.headers !== undefined) void reply.headers(mapped.headers);
    if (mapped.statusCode >= 500) {
      request.log.error({ err: error }, "Error no controlado en la petición");
    } else {
      request.log.warn({ statusCode: mapped.statusCode, code: mapped.body.error.code }, "Petición rechazada");
    }
    return reply.status(mapped.statusCode).send(mapped.body);
  });

  app.setNotFoundHandler((_request, reply) => {
    const mapped = notFoundError();
    return reply.status(mapped.statusCode).send(mapped.body);
  });

  await app.register(rateLimit, {
    global: true,
    max: deps.rateLimit.max,
    timeWindow: deps.rateLimit.timeWindowMs,
    // `Retry-After` en segundos, además de los `x-ratelimit-*`: el móvil lo usa para el backoff de su cola.
    addHeaders: {
      "x-ratelimit-limit": true,
      "x-ratelimit-remaining": true,
      "x-ratelimit-reset": true,
      "retry-after": true,
    },
    ...(deps.rateLimit.keyGenerator !== undefined && { keyGenerator: deps.rateLimit.keyGenerator }),
    ...(deps.rateLimit.hook !== undefined && { hook: deps.rateLimit.hook }),
  });

  registerHealthRoute(app, deps.checkHealth);
  await deps.registerRoutes?.(app);

  return app;
}
