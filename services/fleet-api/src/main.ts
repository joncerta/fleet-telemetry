import { randomBytes, randomUUID } from "node:crypto";
import { TOPICS, ZONE_MAX_PER_TENANT } from "@fleet/contracts";
import { createConsumer, createKafka, createLogger, createPool, createSessionCodec, hashPassword, installGracefulShutdown, sha256Hex, verifyPassword } from "@fleet/platform";
import { createCheckHealth } from "./application/check-health.js";
import { createFleetEventHub } from "./application/fleet-event-hub.js";
import { createCreatePairingCode } from "./application/create-pairing-code.js";
import { createCreateVehicle } from "./application/create-vehicle.js";
import { createCreateZone } from "./application/create-zone.js";
import { createGetFleetSummary } from "./application/get-fleet-summary.js";
import { createGetSession } from "./application/get-session.js";
import { createGetZonesGeoJson } from "./application/get-zones-geojson.js";
import { createListAlerts } from "./application/list-alerts.js";
import { createListStoppedVehicles } from "./application/list-stopped-vehicles.js";
import { createListUsers } from "./application/list-users.js";
import { createListVehicles } from "./application/list-vehicles.js";
import { createLogin } from "./application/login.js";
import { createOpenFleetStream } from "./application/open-fleet-stream.js";
import { createPairDevice } from "./application/pair-device.js";
import { loadFleetApiConfig } from "./config.js";
import { createCryptoPairingCredentials } from "./infrastructure/crypto-pairing-credentials.js";
import { createFixedWindowFailureCounter } from "./infrastructure/fixed-window-failure-counter.js";
import { createPgFleetReadRepository } from "./infrastructure/pg-fleet-read-repository.js";
import { createPgFleetSnapshotReader } from "./infrastructure/pg-fleet-snapshot-reader.js";
import { createPgPairingCodeRepository, createPgPairingUnitOfWork } from "./infrastructure/pg-pairing.js";
import { createPgTenantUserReader } from "./infrastructure/pg-tenant-users.js";
import { createPgUserRepository } from "./infrastructure/pg-user-repository.js";
import { createPgVehicleCatalogRepository } from "./infrastructure/pg-vehicle-catalog.js";
import { createPgZoneRepository } from "./infrastructure/pg-zone-repository.js";
import { createDatabaseCheck, createFeedCheck } from "./infrastructure/readiness.js";
import { registerAuthRoutes } from "./interfaces/http/auth-routes.js";
import { buildApp } from "./interfaces/http/build-app.js";
import { registerCatalogRoutes } from "./interfaces/http/catalog-routes.js";
import { registerDeviceRoutes } from "./interfaces/http/device-routes.js";
import { registerFleetRoutes } from "./interfaces/http/fleet-routes.js";
import { registerStreamRoute } from "./interfaces/http/stream-route.js";
import { createSessionCookies } from "./interfaces/http/session-auth.js";
import { registerZoneRoutes } from "./interfaces/http/zone-routes.js";
import { createFleetEventFeed } from "./interfaces/kafka/fleet-event-feed.js";

// Único composition root de fleet-api: aquí se crean y se conectan los adaptadores. Nada más del servicio construye infraestructura.
// Si la configuración es inválida (por ejemplo un SESSION_SECRET de menos de 32 bytes), `loadFleetApiConfig` lanza y el proceso no arranca.
const SERVICE = "fleet-api";

/** Eventos que un stream guarda mientras se lee su snapshot (unos milisegundos): pasado el tope se corta y el cliente reconecta. */
const MAX_BUFFERED_EVENTS = 10_000;

/** Tope del cuerpo: los cuerpos de esta API son de unos pocos cientos de bytes (login, vehicleId, código). */
const BODY_LIMIT_BYTES = 16 * 1024;

const config = loadFleetApiConfig();
const logger = createLogger({ service: SERVICE, level: config.LOG_LEVEL });

// Pool de la API. El ping de /health va por un pool propio de una conexión: con el de la API saturado, /health no debe dar un falso 503
// ni quitarle conexiones.
const pool = createPool({ connectionString: config.DATABASE_URL, applicationName: SERVICE, logger });
const healthPool = createPool({ connectionString: config.DATABASE_URL, applicationName: `${SERVICE}-health`, logger, max: 1 });
// Pool PROPIO (pequeño) para los snapshots del SSE: tras un reinicio todos los clientes reconectan a la vez y cada uno lee un snapshot; con el pool
// de la API, esa avalancha dejaría sin conexiones al REST. Aquí la cola de snapshots espera en su propio pool.
const snapshotPool = createPool({ connectionString: config.DATABASE_URL, applicationName: `${SERVICE}-sse-snapshot`, logger, max: config.SSE_SNAPSHOT_POOL_MAX });

const sessionCookies = createSessionCookies({
  codec: createSessionCodec(config.SESSION_SECRET),
  ttlSeconds: config.SESSION_TTL_HOURS * 3_600,
  secure: config.FLEET_API_COOKIE_SECURE,
});

const readRepository = createPgFleetReadRepository(pool);
const vehicleCatalog = createPgVehicleCatalogRepository(pool);
const clock = { now: () => new Date() };

// SSE: cada réplica consume vehicle.state y fleet.alerts con un grupo PROPIO (regla 6), desde el final, y reparte en memoria por tenant. No hay
// productor ni DLQ: fleet-api es un read model y un evento inválido se descarta con un log.
const kafka = createKafka({ brokers: config.KAFKA_BROKERS, clientId: SERVICE, logger });
const sseGroupId = `fleet-api-sse-${config.FLEET_API_INSTANCE_ID}`;
const eventHub = createFleetEventHub({ logger });
const eventFeed = createFleetEventFeed({
  consumer: createConsumer(kafka, { groupId: sseGroupId }),
  groupId: sseGroupId,
  topics: { vehicleState: TOPICS.vehicleState, fleetAlerts: TOPICS.fleetAlerts },
  publish: eventHub.publish,
  logger,
  // Un consumer caído sin reinicio deja el proceso vivo y sin entregar eventos: se apaga con código 1 para que el orquestador lo reinicie.
  onFatal: (reason) => {
    void lifecycle.shutdown(reason, 1);
  },
});
const fleetStreams = createOpenFleetStream({
  subscriptions: eventHub,
  snapshots: createPgFleetSnapshotReader(snapshotPool),
  clock,
  logger,
  limits: { maxStreamsPerUser: config.SSE_MAX_STREAMS_PER_USER, maxPendingBytes: config.SSE_MAX_PENDING_BYTES, maxBufferedEvents: MAX_BUFFERED_EVENTS },
});
const credentials = createCryptoPairingCredentials();

// Hash de una contraseña que nadie conoce, con los mismos parámetros que los hashes reales (los por defecto de `hashPassword`): el login
// de un correo inexistente paga el mismo scrypt que el de uno real.
const dummyPasswordHash = await hashPassword(randomBytes(32).toString("hex"));

const app = await buildApp({
  logger,
  trustProxyHops: config.FLEET_API_TRUSTED_PROXY_HOPS,
  bodyLimitBytes: BODY_LIMIT_BYTES,
  rateLimit: { max: config.FLEET_API_RATE_LIMIT_MAX, timeWindowMs: config.FLEET_API_RATE_LIMIT_WINDOW_MS },
  corsOrigins: config.FLEET_API_CORS_ORIGINS,
  checkHealth: createCheckHealth([createDatabaseCheck(healthPool, logger), createFeedCheck(eventFeed)]),
  registerRoutes: (instance) => {
    const users = createPgUserRepository(pool);
    const loginWindow = { max: config.FLEET_API_LOGIN_FAILURE_LIMIT_MAX, timeWindowMs: config.FLEET_API_LOGIN_FAILURE_LIMIT_WINDOW_MS };

    registerAuthRoutes(instance, {
      login: createLogin({ users, passwords: { verify: verifyPassword }, dummyPasswordHash }),
      getSession: createGetSession({ users }),
      cookies: sessionCookies,
      loginLimits: { byIp: createFixedWindowFailureCounter(loginWindow), byEmail: createFixedWindowFailureCounter(loginWindow) },
    });
    registerFleetRoutes(instance, {
      cookies: sessionCookies,
      getSummary: createGetFleetSummary({ reader: readRepository, clock }),
      listStoppedVehicles: createListStoppedVehicles({ reader: readRepository, clock }),
      listAlerts: createListAlerts({ reader: readRepository }),
      getZonesGeoJson: createGetZonesGeoJson({ reader: readRepository }),
    });
    registerCatalogRoutes(instance, {
      cookies: sessionCookies,
      listVehicles: createListVehicles({ catalog: vehicleCatalog }),
      createVehicle: createCreateVehicle({ catalog: vehicleCatalog, newVehicleId: randomUUID }),
      listUsers: createListUsers({ users: createPgTenantUserReader(pool) }),
      createRateLimit: { max: config.FLEET_API_VEHICLE_CREATE_RATE_LIMIT_MAX, timeWindowMs: config.FLEET_API_VEHICLE_CREATE_RATE_LIMIT_WINDOW_MS },
    });
    registerZoneRoutes(instance, {
      cookies: sessionCookies,
      createZone: createCreateZone({ zones: createPgZoneRepository(pool), newZoneId: randomUUID, maxPerTenant: ZONE_MAX_PER_TENANT }),
      createRateLimit: { max: config.FLEET_API_ZONE_CREATE_RATE_LIMIT_MAX, timeWindowMs: config.FLEET_API_ZONE_CREATE_RATE_LIMIT_WINDOW_MS },
    });
    registerStreamRoute(instance, {
      cookies: sessionCookies,
      openFleetStream: fleetStreams.open,
      heartbeatMs: config.SSE_HEARTBEAT_MS,
      corsOrigins: config.FLEET_API_CORS_ORIGINS,
      rateLimit: { max: config.SSE_RATE_LIMIT_MAX, timeWindowMs: config.SSE_RATE_LIMIT_WINDOW_MS },
      reconnect: { baseMs: config.SSE_RETRY_MS, jitterMs: config.SSE_RETRY_JITTER_MS },
    });
    registerDeviceRoutes(instance, {
      cookies: sessionCookies,
      createPairingCode: createCreatePairingCode({
        codes: createPgPairingCodeRepository(pool),
        credentials,
        hash: sha256Hex,
        ttlMinutes: config.FLEET_API_PAIRING_CODE_TTL_MINUTES,
      }),
      pairDevice: createPairDevice({ unitOfWork: createPgPairingUnitOfWork(pool), credentials, hash: sha256Hex }),
      pairFailureLimiter: createFixedWindowFailureCounter({
        max: config.FLEET_API_PAIR_FAILURE_LIMIT_MAX,
        timeWindowMs: config.FLEET_API_PAIR_FAILURE_LIMIT_WINDOW_MS,
      }),
    });
  },
});

// Se instala antes de escuchar: un fallo al arrancar también cierra de forma ordenada lo que ya se abrió.
const lifecycle = installGracefulShutdown({
  logger,
  timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
  steps: [
    // 1) Corta los streams SSE abiertos, pasa a draining (los streams nuevos reciben 503 con Retry-After) y detiene el consumer de Kafka que los alimenta: ANTES de cerrar el servidor, que no espera a una
    //    conexión SSE (nunca termina sola) y se quedaría colgado hasta el tope del apagado.
    { name: "cerrar los streams SSE", run: () => Promise.resolve(fleetStreams.closeAll()) },
    { name: "detener y desconectar el consumer del SSE", run: () => eventFeed.stop() },
    // 2) Deja de aceptar conexiones nuevas y espera a las peticiones en vuelo.
    { name: "cerrar el servidor HTTP", run: () => app.close() },
    // 3) Con nada en vuelo, ya se pueden cerrar los pools.
    { name: "cerrar el pool de Postgres", run: () => pool.end() },
    { name: "cerrar el pool de snapshots del SSE", run: () => snapshotPool.end() },
    { name: "cerrar el pool del ping de salud", run: () => healthPool.end() },
  ],
});

try {
  // El consumer arranca antes de aceptar tráfico: un stream que se abra ya tiene su snapshot leído DESPUÉS de que el feed esté posicionado.
  await eventFeed.start();
  await app.listen({ host: config.FLEET_API_HOST, port: config.FLEET_API_PORT });
  logger.info({ host: config.FLEET_API_HOST, port: config.FLEET_API_PORT }, "fleet-api escuchando");
} catch (err) {
  logger.error({ err }, "No se pudo arrancar fleet-api");
  await lifecycle.shutdown("fallo de arranque", 1);
}
