import {
  alertsResponseTolerantSchema,
  fleetSummarySchema,
  pairingCodeSchema,
  sessionSchema,
  stoppedVehiclesResponseTolerantSchema,
  zoneFeatureCollectionTolerantSchema,
  type AlertsResponseTolerant,
  type FleetSummary,
  type LoginRequest,
  type PairingCode,
  type Session,
  type StoppedVehiclesResponseTolerant,
  type ZoneFeatureCollectionTolerant,
  type ZoneKind,
} from "@fleet/contracts";
import { UnauthorizedError, type HttpClient } from "./http-client";

/** Rutas de fleet-api (`services/fleet-api/src/interfaces/http`). El contrato fija las formas; las rutas no están en `@fleet/contracts`. */
export const FLEET_API_PATHS = {
  login: "/v1/auth/login",
  session: "/v1/auth/session",
  logout: "/v1/auth/logout",
  summary: "/v1/summary",
  stoppedVehicles: "/v1/vehicles/stopped",
  alerts: "/v1/alerts",
  zones: "/v1/zones/geojson",
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
  getSession(): Promise<Session>;
  logout(): Promise<void>;
  getSummary(signal?: AbortSignal): Promise<FleetSummary>;
  getAlerts(params: { status: "active" | "all"; limit: number }, signal?: AbortSignal): Promise<AlertsResponseTolerant>;
  getStoppedVehicles(params: StoppedVehiclesParams, signal?: AbortSignal): Promise<StoppedVehiclesResponseTolerant>;
  getZones(signal?: AbortSignal): Promise<ZoneFeatureCollectionTolerant>;
  createPairingCode(vehicleId: string): Promise<PairingCode>;
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
    getSession: () => http.request(FLEET_API_PATHS.session, { schema: sessionSchema }),
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
    createPairingCode: (vehicleId) =>
      authed(() => http.request(FLEET_API_PATHS.pairingCodes, { method: "POST", body: { vehicleId }, schema: pairingCodeSchema })),
  };
}
