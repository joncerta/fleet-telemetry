import { randomBytes } from "node:crypto";
import { createLogger, createPool, createSessionCodec, hashPassword, installGracefulShutdown, sha256Hex, verifyPassword } from "@fleet/platform";
import { createCheckHealth } from "./application/check-health.js";
import { createCreatePairingCode } from "./application/create-pairing-code.js";
import { createGetFleetSummary } from "./application/get-fleet-summary.js";
import { createGetSession } from "./application/get-session.js";
import { createGetZonesGeoJson } from "./application/get-zones-geojson.js";
import { createListAlerts } from "./application/list-alerts.js";
import { createListStoppedVehicles } from "./application/list-stopped-vehicles.js";
import { createLogin } from "./application/login.js";
import { createPairDevice } from "./application/pair-device.js";
import { loadFleetApiConfig } from "./config.js";
import { createCryptoPairingCredentials } from "./infrastructure/crypto-pairing-credentials.js";
import { createFixedWindowFailureCounter } from "./infrastructure/fixed-window-failure-counter.js";
import { createPgFleetReadRepository } from "./infrastructure/pg-fleet-read-repository.js";
import { createPgPairingCodeRepository, createPgPairingUnitOfWork } from "./infrastructure/pg-pairing.js";
import { createPgUserRepository } from "./infrastructure/pg-user-repository.js";
import { createDatabaseCheck } from "./infrastructure/readiness.js";
import { registerAuthRoutes } from "./interfaces/http/auth-routes.js";
import { buildApp } from "./interfaces/http/build-app.js";
import { registerDeviceRoutes } from "./interfaces/http/device-routes.js";
import { registerFleetRoutes } from "./interfaces/http/fleet-routes.js";
import { createSessionCookies } from "./interfaces/http/session-auth.js";

// Único composition root de fleet-api: aquí se crean y se conectan los adaptadores. Nada más del servicio construye infraestructura.
// Si la configuración es inválida (por ejemplo un SESSION_SECRET de menos de 32 bytes), `loadFleetApiConfig` lanza y el proceso no arranca.
const SERVICE = "fleet-api";

/** Tope del cuerpo: los cuerpos de esta API son de unos pocos cientos de bytes (login, vehicleId, código). */
const BODY_LIMIT_BYTES = 16 * 1024;

const config = loadFleetApiConfig();
const logger = createLogger({ service: SERVICE, level: config.LOG_LEVEL });

// Pool de la API. El ping de /health va por un pool propio de una conexión: con el de la API saturado, /health no debe dar un falso 503
// ni quitarle conexiones.
const pool = createPool({ connectionString: config.DATABASE_URL, applicationName: SERVICE, logger });
const healthPool = createPool({ connectionString: config.DATABASE_URL, applicationName: `${SERVICE}-health`, logger, max: 1 });

const sessionCookies = createSessionCookies({
  codec: createSessionCodec(config.SESSION_SECRET),
  ttlSeconds: config.SESSION_TTL_HOURS * 3_600,
  secure: config.FLEET_API_COOKIE_SECURE,
});

const readRepository = createPgFleetReadRepository(pool);
const clock = { now: () => new Date() };
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
  checkHealth: createCheckHealth([createDatabaseCheck(healthPool, logger)]),
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
    // 1) Deja de aceptar conexiones nuevas y espera a las peticiones en vuelo. (El paso del SSE añadirá antes el cierre de sus streams
    //    y de su consumer de Kafka.)
    { name: "cerrar el servidor HTTP", run: () => app.close() },
    // 2) Con nada en vuelo, ya se pueden cerrar los pools.
    { name: "cerrar el pool de Postgres", run: () => pool.end() },
    { name: "cerrar el pool del ping de salud", run: () => healthPool.end() },
  ],
});

try {
  await app.listen({ host: config.FLEET_API_HOST, port: config.FLEET_API_PORT });
  logger.info({ host: config.FLEET_API_HOST, port: config.FLEET_API_PORT }, "fleet-api escuchando");
} catch (err) {
  logger.error({ err }, "No se pudo arrancar fleet-api");
  await lifecycle.shutdown("fallo de arranque", 1);
}
