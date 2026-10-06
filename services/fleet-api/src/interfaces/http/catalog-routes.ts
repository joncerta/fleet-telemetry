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
 *   propio por usuario.
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
      // `onRequest` de la ruta corre ANTES del límite del plugin: una petición sin sesión es 401 sin consumir cupo de usuario (la cubre el
      // límite global por IP). Con sesión, el cupo es del usuario.
      onRequest,
      config: {
        rateLimit: {
          max: deps.createRateLimit.max,
          timeWindow: deps.createRateLimit.timeWindowMs,
          keyGenerator: (request) => `user:${deps.cookies.identityOf(request)?.userId ?? request.ip}`,
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
