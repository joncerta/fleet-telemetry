import {
  alertsResponseTolerantSchema,
  fleetSummarySchema,
  pairingCodeSchema,
  sessionSchema,
  userListResponseSchema,
  vehicleCatalogItemSchema,
  vehicleListResponseSchema,
  stoppedVehiclesResponseTolerantSchema,
  zoneFeatureCollectionTolerantSchema,
  zoneFeatureTolerantSchema,
  type AlertsResponseTolerant,
  type FleetSummary,
  type LoginRequest,
  type PairingCode,
  type UserListResponse,
  type VehicleCatalogItem,
  type VehicleCreateRequest,
  type VehicleListResponse,
  type Session,
  type StoppedVehiclesResponseTolerant,
  type ZoneCreateRequest,
  type ZoneFeatureCollectionTolerant,
  type ZoneFeatureTolerant,
  type ZoneKind,
} from "@fleet/contracts";
import { UnauthorizedError, type HttpClient } from "./http-client";

/** Rutas de fleet-api (`services/fleet-api/src/interfaces/http`). El contrato fija las formas; las rutas no están en `@fleet/contracts`. */
export const FLEET_API_PATHS = {
  login: "/v1/auth/login",
  session: "/v1/auth/session",
  logout: "/v1/auth/logout",
  summary: "/v1/summary",
  vehicles: "/v1/vehicles",
  users: "/v1/users",
  stoppedVehicles: "/v1/vehicles/stopped",
  alerts: "/v1/alerts",
  zones: "/v1/zones/geojson",
  zoneCreate: "/v1/zones",
  pairingCodes: "/v1/devices/pairing-codes",
  stream: "/v1/stream",
} as const;

export interface StoppedVehiclesParams {
  minMinutes: number;
  zoneKind?: ZoneKind;
  limit: number;
}

export interface FleetApi {
  /** 401 aquí es "credenciales inválidas", no "sesión vencida": NO avisa a `onUnauthorized`. */
  login(credentials: LoginRequest): Promise<Session>;
  getSession(signal?: AbortSignal): Promise<Session>;
  logout(): Promise<void>;
  getSummary(signal?: AbortSignal): Promise<FleetSummary>;
  getAlerts(params: { status: "active" | "all"; limit: number }, signal?: AbortSignal): Promise<AlertsResponseTolerant>;
  getStoppedVehicles(params: StoppedVehiclesParams, signal?: AbortSignal): Promise<StoppedVehiclesResponseTolerant>;
  getZones(signal?: AbortSignal): Promise<ZoneFeatureCollectionTolerant>;
  createPairingCode(vehicleId: string, signal?: AbortSignal): Promise<PairingCode>;
  /** Catálogo de vehículos del tenant (con o sin telemetría), ordenado por placa. */
  listVehicles(limit: number, signal?: AbortSignal): Promise<VehicleListResponse>;
  /** Alta de un vehículo. `request` ya debe estar validado y normalizado con `vehicleCreateRequestSchema`. 409 `plate_taken` si la placa existe. */
  createVehicle(request: VehicleCreateRequest, signal?: AbortSignal): Promise<VehicleCatalogItem>;
  /** Alta de una zona. `request` ya debe estar validado con `zoneCreateRequestSchema`. 409 `zone_name_taken`, 400 `invalid_geometry`. */
  createZone(request: ZoneCreateRequest, signal?: AbortSignal): Promise<ZoneFeatureTolerant>;
  /** Usuarios del tenant de la sesión, ordenados por nombre (solo lectura). */
  listUsers(limit: number, signal?: AbortSignal): Promise<UserListResponse>;
}

/**
 * Fachada tipada de fleet-api. Los tipos salen solo de `@fleet/contracts`, con las variantes TOLERANTES para leer (un enum nuevo del
 * servidor se lee como `unknown` en vez de romper la web). Un 401 de cualquier llamada con sesión avisa a `onUnauthorized` (lleva al
 * login) y además se lanza, para que quien llamó no siga como si tuviera datos.
 */
export function createFleetApi(http: HttpClient, onUnauthorized: () => void): FleetApi {
  const authed = async <T>(call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (error) {
      if (error instanceof UnauthorizedError) onUnauthorized();
      throw error;
    }
  };

  return {
    login: (credentials) => http.request(FLEET_API_PATHS.login, { method: "POST", body: credentials, schema: sessionSchema }),
    // Sin `authed`: el arranque pregunta por la sesión justamente para saber si hay que ir al login.
    getSession: (signal) => http.request(FLEET_API_PATHS.session, { schema: sessionSchema, signal }),
    logout: () => http.request(FLEET_API_PATHS.logout, { method: "POST", schema: null }),
    getSummary: (signal) => authed(() => http.request(FLEET_API_PATHS.summary, { schema: fleetSummarySchema, signal })),
    getAlerts: ({ status, limit }, signal) =>
      authed(() =>
        http.request(`${FLEET_API_PATHS.alerts}?${new URLSearchParams({ status, limit: String(limit) }).toString()}`, {
          schema: alertsResponseTolerantSchema,
          signal,
        }),
      ),
    getStoppedVehicles: ({ minMinutes, zoneKind, limit }, signal) => {
      const query = new URLSearchParams({ minMinutes: String(minMinutes), limit: String(limit) });
      if (zoneKind !== undefined) query.set("zoneKind", zoneKind);
      return authed(() =>
        http.request(`${FLEET_API_PATHS.stoppedVehicles}?${query.toString()}`, { schema: stoppedVehiclesResponseTolerantSchema, signal }),
      );
    },
    getZones: (signal) => authed(() => http.request(FLEET_API_PATHS.zones, { schema: zoneFeatureCollectionTolerantSchema, signal })),
    createPairingCode: (vehicleId, signal) =>
      authed(() => http.request(FLEET_API_PATHS.pairingCodes, { method: "POST", body: { vehicleId }, schema: pairingCodeSchema, signal })),
    listVehicles: (limit, signal) =>
      authed(() => http.request(`${FLEET_API_PATHS.vehicles}?${new URLSearchParams({ limit: String(limit) }).toString()}`, { schema: vehicleListResponseSchema, signal })),
    createVehicle: (request, signal) =>
      authed(() => http.request(FLEET_API_PATHS.vehicles, { method: "POST", body: request, schema: vehicleCatalogItemSchema, signal })),
    createZone: (request, signal) => authed(() => http.request(FLEET_API_PATHS.zoneCreate, { method: "POST", body: request, schema: zoneFeatureTolerantSchema, signal })),
    listUsers: (limit, signal) =>
      authed(() => http.request(`${FLEET_API_PATHS.users}?${new URLSearchParams({ limit: String(limit) }).toString()}`, { schema: userListResponseSchema, signal })),
  };
}
