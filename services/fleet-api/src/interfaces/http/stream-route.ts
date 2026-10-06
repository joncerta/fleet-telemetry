import { apiErrorSchema, SSE_HEARTBEAT_COMMENT } from "@fleet/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
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
}

const errorResponses = { 401: apiErrorSchema, 429: apiErrorSchema, 500: apiErrorSchema } as const;

/** Un evento SSE. `JSON.stringify` no emite saltos de línea, así que `data:` siempre cabe en una línea; `id` y `event` son del servidor (seq y nombres fijos). */
const frameOf = ({ event, id, data }: FleetStreamMessage): string => `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * `GET /v1/stream`: el stream SSE de la flota del tenant de la SESIÓN (cookie; nunca un token en la URL). Solo traduce: valida la sesión, pide al
 * caso de uso que abra el stream y, cuando este le pide la conexión (`attach`), la desvincula de Fastify y escribe las cabeceras.
 *
 * - **Antes de `hijack()`** todo sale por el flujo normal de Fastify (401 sin sesión, 429 por el límite de streams por usuario, 500 si falla el
 *   snapshot), con `apiErrorSchema`, CORS y `x-correlation-id`.
 * - **Después**, los hooks `onSend` no corren: las cabeceras de CORS (`Access-Control-Allow-Origin` del origen permitido y
 *   `Access-Control-Allow-Credentials`), el `x-correlation-id` y `Cache-Control: no-cache` (el global es `no-store`) se escriben a mano.
 * - Heartbeat `: heartbeat` cada `heartbeatMs`; se limpia al cerrarse la conexión.
 * - `Last-Event-ID` se ignora a propósito: toda conexión empieza con un snapshot nuevo (ADR-009).
 */
export function registerStreamRoute(app: FleetApiApp, deps: StreamRouteDependencies): void {
  const allowedOrigins = new Set(deps.corsOrigins);

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

    return {
      deliver: (message) => void raw.write(frameOf(message)),
      pendingBytes: () => raw.writableLength,
      end: () => void raw.destroy(),
      onClose: (listener) => {
        if (alreadyClosed) listener();
        else raw.once("close", listener);
      },
    };
  };

  app.get(STREAM_PATH, { onRequest: deps.cookies.requireSession, schema: { response: errorResponses } }, async (request, reply) => {
    const result = await deps.openFleetStream({ identity: identityOf(request), correlationId: request.id }, () => attach(request, reply));
    if (result.status === "too_many_streams") throw new HttpStatusError(429, "Demasiados streams abiertos para este usuario.");
    // La respuesta ya es del socket (hijack): Fastify no envía nada más.
    return reply;
  });
}
