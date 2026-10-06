import { apiErrorSchema, devicePairRequestSchema, devicePairResponseSchema, pairingCodeCreateRequestSchema, pairingCodeSchema } from "@fleet/contracts";
import { InvalidPairingCodeError } from "../../application/errors.js";
import type { CreatePairingCode } from "../../application/create-pairing-code.js";
import type { PairDevice } from "../../application/pair-device.js";
import type { FailureLimiter } from "./auth-routes.js";
import type { FleetApiApp } from "./build-app.js";
import { clientIpKey } from "./client-ip.js";
import { HttpStatusError } from "./http-status-error.js";
import { identityOf, type SessionCookies } from "./session-auth.js";

export const PAIRING_CODES_PATH = "/v1/devices/pairing-codes";
export const DEVICE_PAIR_PATH = "/v1/devices/pair";

export interface DeviceRouteDependencies {
  cookies: SessionCookies;
  createPairingCode: CreatePairingCode;
  pairDevice: PairDevice;
  /** Fallos del canje por IP (normalizada). El código tiene 40 bits, así que el límite es estricto. */
  pairFailureLimiter: FailureLimiter;
}

const errorResponses = { 400: apiErrorSchema, 413: apiErrorSchema, 415: apiErrorSchema, 429: apiErrorSchema, 500: apiErrorSchema } as const;

/**
 * Vinculación de dispositivos. Ni el código ni el token pasan por logs: las líneas de log llevan solo identificadores.
 * - `POST /v1/devices/pairing-codes` (con sesión): el operador pide un código para un vehículo de SU tenant (el de la sesión); un vehículo
 *   ajeno es 404, igual que uno inexistente.
 * - `POST /v1/devices/pair` (SIN sesión: la llama el móvil): el código es la autenticación. Límite estricto de FALLOS por IP (se consulta antes de
 *   tocar la base y se cuenta cada código inválido). Un código inexistente, usado o vencido da el mismo 404.
 */
export function registerDeviceRoutes(app: FleetApiApp, deps: DeviceRouteDependencies): void {
  app.post(
    PAIRING_CODES_PATH,
    {
      onRequest: deps.cookies.requireSession,
      schema: { body: pairingCodeCreateRequestSchema, response: { 201: pairingCodeSchema, 401: apiErrorSchema, 404: apiErrorSchema, ...errorResponses } },
    },
    async (request, reply) => {
      const identity = identityOf(request);
      const created = await deps.createPairingCode({ identity, vehicleId: request.body.vehicleId });
      request.log.info({ tenantId: identity.tenantId, userId: identity.userId, vehicleId: created.vehicleId }, "Código de vinculación creado");
      return reply.code(201).send(created);
    },
  );

  app.post(
    DEVICE_PAIR_PATH,
    {
      // Antes de leer el cuerpo: una IP bloqueada no hace trabajar ni al parser ni a la base.
      onRequest: (request, reply, done) => {
        const check = deps.pairFailureLimiter.check(clientIpKey(request.ip));
        if (!check.blocked) {
          done();
          return;
        }
        void reply.header("retry-after", check.retryAfterSeconds);
        done(new HttpStatusError(429, "Demasiados canjes fallidos desde esta IP."));
      },
      schema: { body: devicePairRequestSchema, response: { 201: devicePairResponseSchema, 404: apiErrorSchema, ...errorResponses } },
    },
    async (request, reply) => {
      try {
        const paired = await deps.pairDevice(request.body);
        request.log.info({ tenantId: paired.tenantId, deviceId: paired.deviceId, vehicleId: paired.response.vehicleId }, "Dispositivo vinculado");
        return await reply.code(201).send(paired.response);
      } catch (error) {
        if (error instanceof InvalidPairingCodeError) deps.pairFailureLimiter.recordFailure(clientIpKey(request.ip));
        throw error;
      }
    },
  );
}
