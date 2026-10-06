import { apiErrorSchema, batchAckSchema, telemetryBatchEnvelopeSchema, type BatchAck } from "@fleet/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ReceiveTelemetryBatch } from "../../application/receive-telemetry-batch.js";
import type { DeviceContext } from "../../domain/device.js";
import type { GatewayApp } from "./build-app.js";
import { clientIpKey } from "./client-ip.js";
import { HttpStatusError } from "./http-status-error.js";

export const TELEMETRY_BATCHES_PATH = "/v1/telemetry/batches";

/**
 * Fallos de autenticación por IP. `check` solo consulta; `recordFailure` cuenta un 401. Lo implementa un adaptador en
 * memoria (`infrastructure/fixed-window-failure-counter.ts`).
 */
export interface AuthFailureLimiter {
  check(key: string): { blocked: false } | { blocked: true; retryAfterSeconds: number };
  recordFailure(key: string): void;
}

export interface TelemetryRouteDependencies {
  /** Caso de uso de autenticación: devuelve la identidad del token o `null` (todo fallo de credenciales es lo mismo). */
  authenticate: (token: string | undefined) => Promise<DeviceContext | null>;
  receiveBatch: ReceiveTelemetryBatch;
  /** Límite por dispositivo, después de autenticar. */
  deviceRateLimit: { max: number; timeWindowMs: number };
  /**
   * Límite por IP contra la fuerza bruta de tokens: cuenta SOLO los 401 de la IP y solo cambia la respuesta a un token
   * inválido (429 en vez de 401). Un token válido pasa siempre, así que ni las peticiones correctas lo consumen ni un tercero
   * detrás de la misma IP (CGNAT) puede dejar fuera a los legítimos. El tope por IP contra floods (que cuenta
   * todo) lo aplica `buildApp` para todas las rutas.
   */
  authFailureLimiter: AuthFailureLimiter;
}

/** Token del header `Authorization: Bearer <token>`, o `undefined` si falta o no tiene esa forma. El formato lo valida el caso de uso. */
export function bearerToken(header: string | undefined): string | undefined {
  const match = header === undefined ? null : /^Bearer ([^\s]+)$/i.exec(header);
  return match?.[1];
}

/**
 * `POST /v1/telemetry/batches`. Solo traduce: autentica, valida el envelope con el contrato y delega en el caso de
 * uso. Orden de la petición:
 * 1. `onRequest`: tope alto por IP contra floods (de `buildApp`, cuenta todo) -> `429`;
 * 2. `preParsing`: autenticación, antes de leer el cuerpo (un cliente sin token no hace trabajar al parser). Un token válido
 *    siempre pasa. Uno inválido da `401` (que se cuenta contra la IP) o, si la IP ya superó el límite de 401, `429` con
 *    `Retry-After`. Si la base no responde, `503` (no se cuenta: no es culpa del cliente);
 * 3. validación del envelope (`400 invalid_envelope`; `413` y `415` los decide Fastify al leer el cuerpo);
 * 4. `preHandler`: límite por dispositivo (key = `deviceId` de la identidad verificada) -> `429` con `Retry-After`;
 * 5. el caso de uso; `202` con el ACK, o `503` si no se pudo publicar el lote completo.
 *
 * El tenant, el dispositivo y el vehículo salen SOLO del token (regla 4).
 */
export function registerTelemetryRoute(app: GatewayApp, deps: TelemetryRouteDependencies): void {
  // Identidad verificada de cada petición en curso. Un WeakMap en vez de decorar la petición: sin ampliar los tipos de Fastify.
  const authenticated = new WeakMap<object, DeviceContext>();

  const deviceLimit = app.createRateLimit({
    max: deps.deviceRateLimit.max,
    timeWindow: deps.deviceRateLimit.timeWindowMs,
    // Un límite por dispositivo, no por IP. El respaldo a la IP no debería usarse: este hook va después de autenticar.
    keyGenerator: (request) => authenticated.get(request)?.deviceId ?? request.ip,
  });


  async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    // Siempre se autentica, también con la IP por encima del límite: tras un CGNAT comparten IP cientos de dispositivos de
    // tenants distintos, y bloquear por IP antes de mirar el token dejaría sin servicio a los legítimos.
    const device = await deps.authenticate(bearerToken(request.headers.authorization));
    if (device === null) {
      // El límite solo cambia la respuesta a un token INVÁLIDO: 429 con Retry-After en vez de 401.
      // Por IP de cliente normalizada (IPv6 por /64, IPv4 mapeada como IPv4): rotar de IPv6 no esquiva el límite.
      const ipKey = clientIpKey(request.ip);
      const check = deps.authFailureLimiter.check(ipKey);
      if (check.blocked) {
        void reply.header("retry-after", check.retryAfterSeconds);
        throw new HttpStatusError(429, "Demasiados fallos de autenticación desde esta IP.");
      }
      deps.authFailureLimiter.recordFailure(ipKey);
      throw new HttpStatusError(401, "Credenciales ausentes o inválidas.");
    }
    authenticated.set(request, device);
  }

  async function enforceDeviceLimit(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const limit = await deviceLimit(request);
    if (limit.isAllowed || !limit.isExceeded) return;
    const retryAfterSeconds = Math.max(1, limit.ttlInSeconds);
    void reply.header("retry-after", retryAfterSeconds);
    void reply.header("x-ratelimit-limit", limit.max);
    void reply.header("x-ratelimit-remaining", 0);
    void reply.header("x-ratelimit-reset", retryAfterSeconds);
    throw new HttpStatusError(429, "Límite por dispositivo superado.");
  }

  app.post(
    TELEMETRY_BATCHES_PATH,
    {
      preParsing: async (request, reply, payload) => {
        await authenticate(request, reply);
        return payload;
      },
      preHandler: enforceDeviceLimit,
      schema: {
        body: telemetryBatchEnvelopeSchema,
        response: {
          202: batchAckSchema,
          400: apiErrorSchema,
          401: apiErrorSchema,
          413: apiErrorSchema,
          415: apiErrorSchema,
          429: apiErrorSchema,
          500: apiErrorSchema,
          503: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const device = authenticated.get(request);
      // Inalcanzable: el hook de autenticación corta la petición antes. Se comprueba por si alguien cambia el orden de los hooks.
      if (device === undefined) throw new HttpStatusError(401, "Petición sin identidad verificada.");

      const ack = await deps.receiveBatch({ device, correlationId: request.id, envelope: request.body });

      request.log.info(
        {
          tenantId: device.tenantId,
          deviceId: device.deviceId,
          vehicleId: device.vehicleId,
          ...batchCounts(request.body.points.length, ack),
        },
        "Lote de telemetría aceptado",
      );
      return reply.code(202).send(ack);
    },
  );
}

/** Conteos del lote para el log: nunca coordenadas, ni los puntos, ni el token. */
function batchCounts(received: number, ack: BatchAck) {
  const rejectedByReason: Record<string, number> = {};
  for (const { reason } of ack.rejected) rejectedByReason[reason] = (rejectedByReason[reason] ?? 0) + 1;
  return {
    received,
    accepted: ack.accepted.length,
    rejected: ack.rejected.length,
    rejectedByReason,
    // Lo que no es aceptado ni rechazado son eventId repetidos dentro del lote, publicados una sola vez.
    duplicatesInBatch: received - ack.accepted.length - ack.rejected.length,
  };
}
