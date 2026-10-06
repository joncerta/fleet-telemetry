import type { IncomingMessage, ServerResponse } from "node:http";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import type { HealthResponse } from "@fleet/contracts";
import type { Logger } from "@fleet/platform";
import Fastify, { LogController, type FastifyInstance, type FastifyRequest, type RawServerDefault } from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { CORRELATION_ID_HTTP_HEADER, resolveCorrelationId } from "./correlation.js";
import { mapError, notFoundError } from "./errors.js";
import { registerHealthRoute } from "./health-route.js";

/** App de Fastify con el type provider de zod: el tipo de las rutas sale de sus esquemas. */
export type FleetApiApp = FastifyInstance<RawServerDefault, IncomingMessage, ServerResponse, Logger, ZodTypeProvider>;

export interface RateLimitSettings {
  /** Peticiones permitidas por ventana y por IP. */
  max: number;
  timeWindowMs: number;
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
  /** Tope ALTO por IP contra floods: cuenta todas las peticiones. Los límites de login y de canje (más estrictos) están en sus rutas. */
  rateLimit: RateLimitSettings;
  /** Orígenes de la web autorizados a llamar con la cookie de sesión (CORS con credenciales). Lista explícita, sin comodín. */
  corsOrigins: readonly string[];
  /** Caso de uso de `GET /health`. */
  checkHealth: () => Promise<HealthResponse>;
  /** Rutas de los casos de uso. Se registran después de CORS, cookies y el rate limit, para que las cubran. */
  registerRoutes?: (app: FleetApiApp) => void | Promise<void>;
}

/**
 * `trustProxy` por número de saltos. NO se le pasa el número a Fastify: desde 5.12 `trustProxy: <number>` falla en cerrado
 * (siempre "no confiar") porque un conteo de saltos no puede validar al par inmediato. Una función `(dirección, salto) => salto < n`
 * sí da la semántica documentada del conteo. Su riesgo es el que Fastify advierte: si el servicio fuera alcanzable sin pasar por
 * el proxy, un cliente podría falsear su IP; por eso el balanceador debe ser la única entrada (grupo de seguridad), ver ADR-004.
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
 * - Los logs de petición llevan método, ruta y estado; nunca IP, headers (cookie), query ni cuerpo.
 * - Toda respuesta lleva `Cache-Control: no-store`: son datos personales y secretos de un solo uso (sesión, códigos, tokens).
 * - CORS con credenciales solo para los orígenes configurados.
 * - Todo error sale como `apiErrorSchema` (ver `mapError`), sin stack, SQL ni datos personales.
 */
export async function buildApp(deps: AppDependencies): Promise<FleetApiApp> {
  const requestLogger = deps.logger.child(
    {},
    {
      serializers: {
        req: (request: FastifyRequest) => ({ method: request.method, url: pathOf(request.url) }),
        res: (reply: { statusCode: number }) => ({ statusCode: reply.statusCode }),
      },
    },
  );

  const app: FleetApiApp = Fastify({
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

  // Antes de CORS y del rate limit: hasta una respuesta 429 o un preflight llevan el correlationId.
  app.addHook("onRequest", (request, reply, done) => {
    void reply.header(CORRELATION_ID_HTTP_HEADER, request.id);
    void reply.header("cache-control", "no-store");
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

  // CORS antes del rate limit: un 429 también lleva las cabeceras CORS y el navegador puede leerlo. Sin `Origin` (curl, el móvil) no se
  // añade nada; un origen fuera de la lista no recibe `Access-Control-Allow-Origin`.
  await app.register(cors, {
    origin: [...deps.corsOrigins],
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["content-type", CORRELATION_ID_HTTP_HEADER],
    exposedHeaders: [CORRELATION_ID_HTTP_HEADER, "retry-after"],
    maxAge: 600,
  });

  // Sin `secret`: la cookie de sesión la firma el códec de la plataforma, no el plugin; este solo lee y escribe cookies.
  await app.register(cookie);
  app.decorateRequest("auth", null);

  await app.register(rateLimit, {
    global: true,
    max: deps.rateLimit.max,
    timeWindow: deps.rateLimit.timeWindowMs,
    addHeaders: {
      "x-ratelimit-limit": true,
      "x-ratelimit-remaining": true,
      "x-ratelimit-reset": true,
      "retry-after": true,
    },
  });

  registerHealthRoute(app, deps.checkHealth);
  await deps.registerRoutes?.(app);

  return app;
}
