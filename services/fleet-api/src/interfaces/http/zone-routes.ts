import { apiErrorSchema, zoneCreateRequestSchema, zoneFeatureSchema } from "@fleet/contracts";
import type { CreateZone } from "../../application/create-zone.js";
import type { FleetApiApp } from "./build-app.js";
import { identityOf, type SessionCookies } from "./session-auth.js";

export const ZONES_PATH = "/v1/zones";

export interface ZoneRouteDependencies {
  cookies: SessionCookies;
  createZone: CreateZone;
  /** Altas por usuario y ventana (cada alta escribe en la base). Superado: 429 con Retry-After. */
  createRateLimit: { max: number; timeWindowMs: number };
}

/**
 * Alta de zonas. Solo traduce: la sesión (`preParsing`, antes de leer el cuerpo) fija la identidad, la entrada se valida con el contrato, el
 * caso de uso recibe la identidad de la SESIÓN (nunca un tenant de la petición) y la respuesta se serializa con su esquema. El nombre, el
 * polígono y los errores de la base no pasan por los logs: la línea lleva solo identificadores.
 *
 * - `POST /v1/zones`: 201 con el `Feature` de la zona; 409 `zone_name_taken`; 400 `invalid_geometry` (PostGIS) o `invalid_request` (esquema);
 *   401; 415 (solo `application/json`, anti-CSRF como el resto de las escrituras con cookie); 429 (límite por usuario, por IP sin sesión).
 *   La lectura sigue en `GET /v1/zones/geojson` (`registerFleetRoutes`).
 */
export function registerZoneRoutes(app: FleetApiApp, deps: ZoneRouteDependencies): void {
  app.post(
    ZONES_PATH,
    {
      // `preParsing` y no `onRequest`: el límite es un hook `onRequest` que el plugin añade DESPUÉS de los `onRequest` de la ruta, y la ruta trae
      // su propio `config.rateLimit`. Con la sesión en `preParsing` el límite corre después de ella (conoce al usuario) y también cuenta a quien no
      // tiene sesión, por IP; la sesión se verifica antes de leer el cuerpo.
      preParsing: deps.cookies.requireSession,
      config: {
        rateLimit: {
          max: deps.createRateLimit.max,
          timeWindow: deps.createRateLimit.timeWindowMs,
          keyGenerator: (request) => {
            const identity = deps.cookies.identityOf(request);
            return identity === undefined ? `ip:${request.ip}` : `user:${identity.userId}`;
          },
        },
      },
      schema: {
        body: zoneCreateRequestSchema,
        response: {
          201: zoneFeatureSchema,
          400: apiErrorSchema,
          401: apiErrorSchema,
          409: apiErrorSchema,
          413: apiErrorSchema,
          415: apiErrorSchema,
          429: apiErrorSchema,
          500: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const identity = identityOf(request);
      const zone = await deps.createZone({ identity, zone: request.body });
      request.log.info({ tenantId: identity.tenantId, userId: identity.userId, zoneId: zone.properties.zoneId }, "Zona creada");
      return reply.code(201).send(zone);
    },
  );
}
