import { apiErrorSchema, SSE_HEARTBEAT_COMMENT } from "@fleet/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ServerDrainingError } from "../../application/errors.js";
import type { OpenFleetStream } from "../../application/open-fleet-stream.js";
import type { FleetStreamMessage, FleetStreamSink } from "../../application/ports.js";
import type { FleetApiApp } from "./build-app.js";
import { CORRELATION_ID_HTTP_HEADER } from "./correlation.js";
import { HttpStatusError } from "./http-status-error.js";
import { identityOf, type SessionCookies } from "./session-auth.js";

export const STREAM_PATH = "/v1/stream";

export interface StreamRouteDependencies {
  cookies: SessionCookies;
  openFleetStream: OpenFleetStream["open"];
  /** Cada cuántos ms se escribe el comentario `: heartbeat` (acotado por el idle timeout del ALB, ver la configuración). */
  heartbeatMs: number;
  /** Los MISMOS orígenes que el CORS de la app: tras `hijack()` ya no corren los hooks que lo escriben, y se escribe aquí. */
  corsOrigins: readonly string[];
  /** Conexiones nuevas por USUARIO y ventana (cada una cuesta un snapshot a la base). Superado: 429 con `Retry-After`. */
  rateLimit: { max: number; timeWindowMs: number };
  /**
   * Reconexión del cliente (`retry:` del primer frame): `baseMs` más un jitter aleatorio de `0` a `jitterMs`. Sin jitter, tras un reinicio todos
   * los clientes vuelven en el mismo instante (estampida) y cada uno cuesta un snapshot.
   */
  reconnect: { baseMs: number; jitterMs: number };
  /** Aleatorio en [0, 1), inyectable para los tests. */
  random?: () => number;
}

const errorResponses = { 401: apiErrorSchema, 429: apiErrorSchema, 500: apiErrorSchema, 503: apiErrorSchema } as const;

/** Un evento SSE. `JSON.stringify` no emite saltos de línea, así que `data:` siempre cabe en una línea; `id` y `event` son del servidor (seq y nombres fijos). */
const frameOf = ({ event, id, data }: FleetStreamMessage, retryMs?: number): string =>
  `${retryMs === undefined ? "" : `retry: ${retryMs}\n`}id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * `GET /v1/stream`: el stream SSE de la flota del tenant de la SESIÓN (cookie; nunca un token en la URL). Solo traduce: valida la sesión, pide al
 * caso de uso que abra el stream y, cuando este le pide la conexión (`attach`), la desvincula de Fastify y escribe las cabeceras.
 *
 * - **Antes de `hijack()`** todo sale por el flujo normal de Fastify (401 sin sesión, 429 por el límite de streams por usuario, 500 si falla el
 *   snapshot), con `apiErrorSchema`, CORS y `x-correlation-id`.
 * - **Después**, los hooks `onSend` no corren: las cabeceras de CORS (`Access-Control-Allow-Origin` del origen permitido y
 *   `Access-Control-Allow-Credentials`), el `x-correlation-id` y `Cache-Control: no-cache` (el global es `no-store`) se escriben a mano.
 * - El PRIMER frame (el snapshot) lleva `retry: <base + jitter>`: cuánto espera el navegador antes de reconectar, con jitter para que un
 *   reinicio no provoque una estampida.
 * - Con la réplica apagándose (`draining`) responde `503 shutting_down` con `Retry-After`, también antes de `hijack()`.
 * - El límite de conexiones nuevas es POR USUARIO (la cookie verificada; sin sesión válida, por IP): detrás de un NAT o del ALB la IP es
 *   compartida y penalizaría a una oficina entera.
 * - Heartbeat `: heartbeat` cada `heartbeatMs`; se limpia al cerrarse la conexión.
 * - `Last-Event-ID` se ignora a propósito: toda conexión empieza con un snapshot nuevo (ADR-009).
 */
export function registerStreamRoute(app: FleetApiApp, deps: StreamRouteDependencies): void {
  const allowedOrigins = new Set(deps.corsOrigins);
  const random = deps.random ?? Math.random;

  const attach = (request: FastifyRequest, reply: FastifyReply): FleetStreamSink => {
    const origin = request.headers.origin;
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      [CORRELATION_ID_HTTP_HEADER]: request.id,
      // `Vary: Origin` siempre: la respuesta depende del origen aunque a este no se le conceda nada.
      vary: "Origin",
      ...(origin !== undefined && allowedOrigins.has(origin) && { "access-control-allow-origin": origin, "access-control-allow-credentials": "true" }),
    });
    raw.flushHeaders();
    // Un stream vive horas: sin timeout de inactividad del socket, con TCP keep-alive para detectar pares muertos y sin Nagle (eventos pequeños).
    request.socket.setTimeout(0);
    request.socket.setKeepAlive(true);
    request.socket.setNoDelay(true);
    // Un error de escritura (par caído) llega también como `close`, que limpia todo; sin listener, `error` sería una excepción no capturada.
    raw.on("error", () => undefined);

    // El cliente pudo colgar mientras se leía el snapshot: entonces el `close` ya ocurrió y no volverá a emitirse. Sin esta guarda, la
    // suscripción, el cupo del usuario y el intervalo del latido quedarían colgados para siempre.
    const alreadyClosed = raw.destroyed || request.socket.destroyed;
    const heartbeat = alreadyClosed
      ? undefined
      : setInterval(() => {
          if (!raw.destroyed && !raw.writableEnded) raw.write(`: ${SSE_HEARTBEAT_COMMENT}\n\n`);
        }, deps.heartbeatMs);
    raw.once("close", () => clearInterval(heartbeat));

    // `retry:` solo en el primer frame: el navegador lo recuerda para todas sus reconexiones de este stream.
    let retryMs: number | undefined = deps.reconnect.baseMs + Math.floor(random() * deps.reconnect.jitterMs);
    return {
      deliver: (message) => {
        const frame = frameOf(message, retryMs);
        retryMs = undefined;
        raw.write(frame);
      },
      pendingBytes: () => raw.writableLength,
      end: () => void raw.destroy(),
      onClose: (listener) => {
        if (alreadyClosed) listener();
        else raw.once("close", listener);
      },
    };
  };

  app.get(
    STREAM_PATH,
    {
      // `preValidation` y no `onRequest`: el límite de abajo es un hook `onRequest` que el plugin añade DESPUÉS de los `onRequest` de la ruta, y
      // tiene que correr antes de la autenticación para que las peticiones sin sesión también cuenten (por IP).
      preValidation: deps.cookies.requireSession,
      config: {
        rateLimit: {
          max: deps.rateLimit.max,
          timeWindow: deps.rateLimit.timeWindowMs,
          keyGenerator: (request) => {
            const identity = deps.cookies.identityOf(request);
            return identity === undefined ? `ip:${request.ip}` : `user:${identity.userId}`;
          },
        },
      },
      schema: { response: errorResponses },
    },
    async (request, reply) => {
      const result = await deps.openFleetStream({ identity: identityOf(request), correlationId: request.id }, () => attach(request, reply));
      if (result.status === "too_many_streams") throw new HttpStatusError(429, "Demasiados streams abiertos para este usuario.");
      if (result.status === "draining") throw new ServerDrainingError();
      // La respuesta ya es del socket (hijack): Fastify no envía nada más.
      return reply;
    },
  );
}
