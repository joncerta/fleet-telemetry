import { randomUUID } from "node:crypto";
import type { Alert, DevicePairResponse, FleetSummary, PairingCode, Session, StoppedVehiclesResponse, VehicleState, ZoneFeatureCollection } from "@fleet/contracts";
import { createLogger, createSessionCodec } from "@fleet/platform";
import { vi } from "vitest";
import type { CreatePairingCode } from "../application/create-pairing-code.js";
import { createFleetEventHub } from "../application/fleet-event-hub.js";
import type { GetFleetSummary } from "../application/get-fleet-summary.js";
import type { GetSession } from "../application/get-session.js";
import type { GetZonesGeoJson } from "../application/get-zones-geojson.js";
import type { ListAlerts } from "../application/list-alerts.js";
import type { ListStoppedVehicles } from "../application/list-stopped-vehicles.js";
import type { Login } from "../application/login.js";
import { createOpenFleetStream, type OpenFleetStream } from "../application/open-fleet-stream.js";
import type { PairDevice } from "../application/pair-device.js";
import type { FleetSnapshotReader } from "../application/ports.js";
import type { AuthIdentity } from "../domain/identity.js";
import { createFixedWindowFailureCounter } from "../infrastructure/fixed-window-failure-counter.js";
import { registerAuthRoutes } from "../interfaces/http/auth-routes.js";
import { buildApp, type AppDependencies, type FleetApiApp } from "../interfaces/http/build-app.js";
import { registerDeviceRoutes } from "../interfaces/http/device-routes.js";
import { registerFleetRoutes } from "../interfaces/http/fleet-routes.js";
import { registerStreamRoute } from "../interfaces/http/stream-route.js";
import { createSessionCookies, SESSION_COOKIE_NAME } from "../interfaces/http/session-auth.js";

/** Soporte de los tests de la capa HTTP: la app real de `buildApp` con las rutas reales y casos de uso falsos. No forma parte del build. */

export const TEST_SECRET = "t".repeat(32);
export const ALLOWED_ORIGIN = "http://localhost:3000";

export const NORTE: AuthIdentity = { userId: randomUUID(), tenantId: randomUUID() };
export const SUR: AuthIdentity = { userId: randomUUID(), tenantId: randomUUID() };

export const SESSION: Session = {
  user: { userId: NORTE.userId, email: "operador@norte.test", name: "Operador Norte" },
  tenant: { tenantId: NORTE.tenantId, name: "Flota Norte" },
};

export const SUMMARY: FleetSummary = { serverTime: "2026-10-06T12:00:00.000Z", vehicles: { total: 3, moving: 1, stopped: 1, noSignal: 1 }, activeAlerts: 2 };
export const STOPPED: StoppedVehiclesResponse = { serverTime: "2026-10-06T12:00:00.000Z", items: [] };
export const ZONES: ZoneFeatureCollection = { type: "FeatureCollection", features: [] };
export const STREAM_VEHICLE: VehicleState = {
  vehicleId: randomUUID(),
  plate: "ABC123",
  lon: -75.5636,
  lat: 6.2518,
  recordedAt: "2026-10-06T11:59:00.000Z",
  receivedAt: "2026-10-06T11:59:01.000Z",
  speedMps: 0,
  headingDeg: null,
  movement: "stopped",
  stoppedSince: "2026-10-06T11:30:00.000Z",
  zoneIds: [],
  mocked: false,
  lowAccuracy: false,
  seq: "7",
};
export const PAIRING_CODE = (vehicleId: string): PairingCode => ({ code: "K7M2QX9P", vehicleId, expiresAt: "2026-10-06T12:10:00.000Z" });
export const PAIRED = (vehicleId: string): DevicePairResponse => ({
  deviceToken: "fdt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  vehicleId,
  plate: "ABC123",
  pairedAt: "2026-10-06T12:00:00.000Z",
});

export interface TestUseCases {
  login: Login;
  getSession: GetSession;
  getSummary: GetFleetSummary;
  listStoppedVehicles: ListStoppedVehicles;
  listAlerts: ListAlerts;
  getZonesGeoJson: GetZonesGeoJson;
  createPairingCode: CreatePairingCode;
  pairDevice: PairDevice;
  openFleetStream: OpenFleetStream["open"];
}

export interface TestAppOptions {
  useCases?: Partial<TestUseCases>;
  app?: Partial<AppDependencies>;
  loginLimit?: { max: number; timeWindowMs: number };
  pairLimit?: { max: number; timeWindowMs: number };
  secureCookie?: boolean;
  /** Cada cuántos ms late el stream SSE (por defecto 15 s). */
  heartbeatMs?: number;
  /** Conexiones SSE nuevas por usuario y ventana (por defecto, holgado). */
  streamRateLimit?: { max: number; timeWindowMs: number };
  /** Reconexión del cliente SSE (`retry:`), y el aleatorio del jitter. */
  reconnect?: { baseMs: number; jitterMs: number };
  random?: () => number;
  /** Qué lee el snapshot del stream (por defecto un vehículo). */
  snapshots?: FleetSnapshotReader;
  /** Límites del caso de uso del stream. */
  streamLimits?: { maxStreamsPerUser?: number; maxPendingBytes?: number; maxBufferedEvents?: number };
  /** Reloj de la cookie (ms). */
  now?: () => number;
}

const noAlerts: Alert[] = [];

/** Arma la app con las rutas reales, un logger que guarda cada línea y casos de uso falsos (los de `useCases` los reemplazan). */
export async function makeTestApp(options: TestAppOptions = {}) {
  const lines: string[] = [];
  const logger = createLogger({ service: "fleet-api-test", level: "info", destination: { write: (line: string) => void lines.push(line) } });
  const codec = createSessionCodec(TEST_SECRET);
  const now = options.now ?? Date.now;
  const cookies = createSessionCookies({ codec, ttlSeconds: 3_600, secure: options.secureCookie ?? false, now });

  // El stream usa el caso de uso REAL con un hub en memoria (expuesto como `hub`) y un snapshot falso: los tests de la ruta prueban el HTTP real.
  const hub = createFleetEventHub({ logger });
  const snapshotRead = vi.fn<FleetSnapshotReader["read"]>(() => Promise.resolve({ vehicles: [STREAM_VEHICLE], alerts: [] }));
  const snapshots: FleetSnapshotReader = options.snapshots ?? { read: snapshotRead };
  const fleetStream = createOpenFleetStream({
    subscriptions: hub,
    snapshots,
    clock: { now: () => new Date("2026-10-06T12:00:00.000Z") },
    logger,
    limits: { maxStreamsPerUser: 5, maxPendingBytes: 1_048_576, maxBufferedEvents: 1_000, ...options.streamLimits },
  });

  const useCases = {
    login: vi.fn<Login>(() => Promise.resolve({ identity: NORTE, session: SESSION })),
    getSession: vi.fn<GetSession>(() => Promise.resolve(SESSION)),
    getSummary: vi.fn<GetFleetSummary>(() => Promise.resolve(SUMMARY)),
    listStoppedVehicles: vi.fn<ListStoppedVehicles>(() => Promise.resolve(STOPPED)),
    listAlerts: vi.fn<ListAlerts>(() => Promise.resolve({ items: noAlerts, next: null })),
    getZonesGeoJson: vi.fn<GetZonesGeoJson>(() => Promise.resolve(ZONES)),
    createPairingCode: vi.fn<CreatePairingCode>(({ vehicleId }) => Promise.resolve(PAIRING_CODE(vehicleId))),
    pairDevice: vi.fn<PairDevice>(() => Promise.resolve({ response: PAIRED(randomUUID()), tenantId: NORTE.tenantId, deviceId: randomUUID() })),
    openFleetStream: fleetStream.open,
    ...options.useCases,
  } satisfies TestUseCases;

  const loginWindow = options.loginLimit ?? { max: 5, timeWindowMs: 60_000 };
  const pairFailureLimiter = createFixedWindowFailureCounter(options.pairLimit ?? { max: 3, timeWindowMs: 60_000 });

  const app: FleetApiApp = await buildApp({
    logger,
    trustProxyHops: 1,
    bodyLimitBytes: 16_384,
    rateLimit: { max: 1_000, timeWindowMs: 60_000 },
    corsOrigins: [ALLOWED_ORIGIN],
    checkHealth: () => Promise.resolve({ status: "ok", checks: { database: "up" } }),
    registerRoutes: (instance) => {
      registerAuthRoutes(instance, {
        login: useCases.login,
        getSession: useCases.getSession,
        cookies,
        loginLimits: { byIp: createFixedWindowFailureCounter(loginWindow), byEmail: createFixedWindowFailureCounter(loginWindow) },
      });
      registerFleetRoutes(instance, {
        cookies,
        getSummary: useCases.getSummary,
        listStoppedVehicles: useCases.listStoppedVehicles,
        listAlerts: useCases.listAlerts,
        getZonesGeoJson: useCases.getZonesGeoJson,
      });
      registerStreamRoute(instance, {
        cookies,
        openFleetStream: useCases.openFleetStream,
        heartbeatMs: options.heartbeatMs ?? 15_000,
        corsOrigins: [ALLOWED_ORIGIN],
        rateLimit: options.streamRateLimit ?? { max: 1_000, timeWindowMs: 60_000 },
        reconnect: options.reconnect ?? { baseMs: 3_000, jitterMs: 5_000 },
        ...(options.random !== undefined && { random: options.random }),
      });
      registerDeviceRoutes(instance, { cookies, createPairingCode: useCases.createPairingCode, pairDevice: useCases.pairDevice, pairFailureLimiter });
    },
    ...options.app,
  });

  /** Header `cookie` de una sesión válida de esa identidad. */
  const sessionCookieOf = (identity: AuthIdentity, expSeconds = Math.floor(now() / 1_000) + 3_600): string =>
    `${SESSION_COOKIE_NAME}=${codec.sign({ ...identity, exp: expSeconds })}`;

  return {
    app,
    hub,
    fleetStream,
    snapshotRead,
    useCases,
    codec,
    sessionCookieOf,
    logged: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    raw: () => lines.join(""),
  };
}
