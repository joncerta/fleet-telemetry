import {
  apiErrorSchema,
  userListQuerySchema,
  userListResponseSchema,
  vehicleCatalogItemSchema,
  vehicleCreateRequestSchema,
  vehicleListQuerySchema,
  vehicleListResponseSchema,
} from "@fleet/contracts";
import type { CreateVehicle } from "../../application/create-vehicle.js";
import type { ListUsers } from "../../application/list-users.js";
import type { ListVehicles } from "../../application/list-vehicles.js";
import type { FleetApiApp } from "./build-app.js";
import { identityOf, type SessionCookies } from "./session-auth.js";

export const VEHICLES_PATH = "/v1/vehicles";
export const USERS_PATH = "/v1/users";

export interface CatalogRouteDependencies {
  cookies: SessionCookies;
  listVehicles: ListVehicles;
  createVehicle: CreateVehicle;
  listUsers: ListUsers;
  /** Altas por usuario y ventana (cada alta escribe en la base). Superado: 429 con Retry-After. */
  createRateLimit: { max: number; timeWindowMs: number };
}

const readErrors = { 400: apiErrorSchema, 401: apiErrorSchema, 429: apiErrorSchema, 500: apiErrorSchema } as const;

/**
 * Catálogo de vehículos y listado de usuarios. Solo traducen: la sesión (`onRequest`, antes de leer el cuerpo) fija la identidad, la
 * entrada se valida con el contrato, el caso de uso recibe el `tenantId` de la SESIÓN (nunca de la petición) y la respuesta se serializa
 * con su esquema. Ni la placa, ni el alias, ni el nombre ni el correo pasan por los logs: las líneas llevan solo identificadores.
 *
 * - `GET /v1/vehicles`: catálogo del tenant, por placa.
 * - `POST /v1/vehicles`: alta (201; 409 `plate_taken`; 400 si no valida). Protegida como el resto de las escrituras con cookie: sesión
 *   `SameSite=Lax` + CORS con lista de orígenes + solo `application/json` (un formulario de otro sitio no puede enviarlo), más un límite
 *   propio por usuario (por IP si no hay sesión).
 * - `GET /v1/users`: usuarios del tenant, solo lectura.
 */
export function registerCatalogRoutes(app: FleetApiApp, deps: CatalogRouteDependencies): void {
  const onRequest = deps.cookies.requireSession;

  app.get(
    VEHICLES_PATH,
    { onRequest, schema: { querystring: vehicleListQuerySchema, response: { 200: vehicleListResponseSchema, ...readErrors } } },
    async (request) => deps.listVehicles({ tenantId: identityOf(request).tenantId, limit: request.query.limit }),
  );

  app.post(
    VEHICLES_PATH,
    {
      // `preParsing` y no `onRequest`: el límite de abajo es un hook `onRequest` que el plugin añade DESPUÉS de los `onRequest` de la ruta, y
      // la ruta trae su propio `config.rateLimit`, así que el límite global no la cubre. Con la sesión en `preParsing` el límite corre antes
      // (y cuenta también a quien no tiene sesión, por IP) y la sesión se verifica antes de leer el cuerpo.
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
        body: vehicleCreateRequestSchema,
        response: { 201: vehicleCatalogItemSchema, 409: apiErrorSchema, 413: apiErrorSchema, 415: apiErrorSchema, ...readErrors },
      },
    },
    async (request, reply) => {
      const identity = identityOf(request);
      const vehicle = await deps.createVehicle({ identity, vehicle: request.body });
      request.log.info({ tenantId: identity.tenantId, userId: identity.userId, vehicleId: vehicle.vehicleId }, "Vehículo creado");
      return reply.code(201).send(vehicle);
    },
  );

  app.get(
    USERS_PATH,
    { onRequest, schema: { querystring: userListQuerySchema, response: { 200: userListResponseSchema, ...readErrors } } },
    async (request) => deps.listUsers({ tenantId: identityOf(request).tenantId, limit: request.query.limit }),
  );
}
