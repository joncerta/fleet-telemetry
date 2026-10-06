import {
  alertsQuerySchema,
  alertsResponseSchema,
  apiErrorSchema,
  fleetSummarySchema,
  stoppedVehiclesQuerySchema,
  stoppedVehiclesResponseSchema,
  zoneFeatureCollectionSchema,
} from "@fleet/contracts";
import type { GetFleetSummary } from "../../application/get-fleet-summary.js";
import type { GetZonesGeoJson } from "../../application/get-zones-geojson.js";
import type { ListAlerts } from "../../application/list-alerts.js";
import type { ListStoppedVehicles } from "../../application/list-stopped-vehicles.js";
import { decodeAlertCursor, encodeAlertCursor } from "./alert-cursor.js";
import type { FleetApiApp } from "./build-app.js";
import { identityOf, type SessionCookies } from "./session-auth.js";

export const SUMMARY_PATH = "/v1/summary";
export const STOPPED_VEHICLES_PATH = "/v1/vehicles/stopped";
export const ALERTS_PATH = "/v1/alerts";
export const ZONES_GEOJSON_PATH = "/v1/zones/geojson";

export interface FleetRouteDependencies {
  cookies: SessionCookies;
  getSummary: GetFleetSummary;
  listStoppedVehicles: ListStoppedVehicles;
  listAlerts: ListAlerts;
  getZonesGeoJson: GetZonesGeoJson;
}

const errorResponses = { 400: apiErrorSchema, 401: apiErrorSchema, 429: apiErrorSchema, 500: apiErrorSchema } as const;

/**
 * Lecturas del read model. Solo traducen: la sesión (`onRequest`, antes de leer nada) fija la identidad, la querystring se valida con
 * el contrato, el caso de uso recibe el `tenantId` de la SESIÓN (nunca de la petición) y la respuesta se serializa con su esquema.
 */
export function registerFleetRoutes(app: FleetApiApp, deps: FleetRouteDependencies): void {
  const onRequest = deps.cookies.requireSession;

  app.get(SUMMARY_PATH, { onRequest, schema: { response: { 200: fleetSummarySchema, ...errorResponses } } }, async (request) =>
    deps.getSummary({ tenantId: identityOf(request).tenantId }),
  );

  app.get(
    STOPPED_VEHICLES_PATH,
    { onRequest, schema: { querystring: stoppedVehiclesQuerySchema, response: { 200: stoppedVehiclesResponseSchema, ...errorResponses } } },
    async (request) => deps.listStoppedVehicles({ tenantId: identityOf(request).tenantId, ...request.query }),
  );

  app.get(
    ALERTS_PATH,
    { onRequest, schema: { querystring: alertsQuerySchema, response: { 200: alertsResponseSchema, ...errorResponses } } },
    async (request) => {
      const { status, limit, cursor } = request.query;
      // El cursor es opaco para el cliente: aquí se decodifica y se valida antes de llegar a SQL (`400 invalid_cursor`).
      const page = await deps.listAlerts({
        tenantId: identityOf(request).tenantId,
        status,
        limit,
        after: cursor === undefined ? undefined : decodeAlertCursor(cursor),
      });
      return { items: page.items, nextCursor: page.next === null ? null : encodeAlertCursor(page.next) };
    },
  );

  app.get(ZONES_GEOJSON_PATH, { onRequest, schema: { response: { 200: zoneFeatureCollectionSchema, ...errorResponses } } }, async (request) =>
    deps.getZonesGeoJson({ tenantId: identityOf(request).tenantId }),
  );
}
