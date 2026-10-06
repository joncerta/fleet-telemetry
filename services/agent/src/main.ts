import { createLogger, createSessionCodec, installGracefulShutdown } from "@fleet/platform";
import { createChat } from "./application/chat.js";
import { createCheckHealth } from "./application/check-health.js";
import { createGetActiveAlerts } from "./application/get-active-alerts.js";
import { createGetFleetSummary } from "./application/get-fleet-summary.js";
import { createGetStoppedVehicles } from "./application/get-stopped-vehicles.js";
import { SYSTEM_PROMPT } from "./application/system-prompt.js";
import { loadAgentConfig } from "./config.js";
import { createChatModel } from "./infrastructure/chat-model.js";
import { createLangChainChatAgent } from "./infrastructure/langchain-chat-agent.js";
import { createResilientFleetClient } from "./infrastructure/resilient-fleet-client.js";
import { createFleetTools } from "./interfaces/agent/tools.js";
import { buildApp } from "./interfaces/http/build-app.js";
import { registerChatRoute } from "./interfaces/http/chat-route.js";
import { createSessionAuth } from "./interfaces/http/session-auth.js";

// Único composition root del agente: aquí se crean y se conectan los adaptadores. Nada más del servicio construye infraestructura.
// Si la configuración es inválida (por ejemplo un SESSION_SECRET de menos de 32 bytes, o falta ANTHROPIC_API_KEY con el proveedor
// real), `loadAgentConfig` lanza y el proceso no arranca.
const SERVICE = "agent";

/** Tope del cuerpo: una pregunta son como mucho 2000 caracteres (hasta unos 8 KB en UTF-8) más el JSON que la envuelve. */
const BODY_LIMIT_BYTES = 16 * 1024;

const config = loadAgentConfig();
const logger = createLogger({ service: SERVICE, level: config.LOG_LEVEL });

// El cliente de fleet-api se crea UNA vez y lleva el breaker de esa dependencia: un breaker por petición no acumularía fallos.
const fleet = createResilientFleetClient({
  baseUrl: config.FLEET_API_URL,
  breaker: {
    timeoutMs: config.AGENT_FLEET_API_TIMEOUT_MS,
    errorThresholdPercentage: config.AGENT_BREAKER_ERROR_THRESHOLD_PERCENTAGE,
    volumeThreshold: config.AGENT_BREAKER_VOLUME_THRESHOLD,
    resetTimeoutMs: config.AGENT_BREAKER_RESET_TIMEOUT_MS,
    rollingWindowMs: config.AGENT_BREAKER_ROLLING_WINDOW_MS,
  },
  logger,
});
const breaker = { state: () => fleet.breakerState() };

const useCases = {
  getStoppedVehicles: createGetStoppedVehicles({ fleet }),
  getFleetSummary: createGetFleetSummary({ fleet }),
  getActiveAlerts: createGetActiveAlerts({ fleet }),
};

// `loadAgentConfig` ya exigió la API key con el proveedor real; con el de guion no se usa.
const model = createChatModel({ provider: config.AGENT_MODEL_PROVIDER, model: config.AGENT_MODEL, apiKey: config.ANTHROPIC_API_KEY });

const agent = createLangChainChatAgent({
  model,
  systemPrompt: SYSTEM_PROMPT,
  maxIterations: config.AGENT_MAX_ITERATIONS,
  timeoutMs: config.AGENT_TIMEOUT_MS,
  toolsFor: ({ context, record }) =>
    createFleetTools({
      ...useCases,
      context,
      record,
      // Solo el tipo del error: el mensaje puede arrastrar datos de la flota. Con el contexto de la petición, para poder rastrearlo.
      onError: (tool, error) =>
        logger.error(
          { tool, tenantId: context.identity.tenantId, correlationId: context.correlationId, errorType: error instanceof Error ? error.name : typeof error },
          "Fallo inesperado en una herramienta del agente",
        ),
    }),
});

const auth = createSessionAuth({ codec: createSessionCodec(config.SESSION_SECRET) });

const app = await buildApp({
  logger,
  trustProxyHops: config.AGENT_TRUSTED_PROXY_HOPS,
  bodyLimitBytes: BODY_LIMIT_BYTES,
  rateLimit: { max: config.AGENT_RATE_LIMIT_MAX, timeWindowMs: config.AGENT_RATE_LIMIT_WINDOW_MS },
  corsOrigins: config.AGENT_CORS_ORIGINS,
  checkHealth: createCheckHealth({ fleetApi: breaker }),
  registerRoutes: (instance) => {
    registerChatRoute(instance, {
      auth,
      chat: createChat({ agent, breaker }),
      userRateLimit: { max: config.AGENT_USER_RATE_LIMIT_MAX, timeWindowMs: config.AGENT_USER_RATE_LIMIT_WINDOW_MS },
    });
  },
});

// Se instala antes de escuchar: un fallo al arrancar también cierra de forma ordenada lo que ya se abrió.
const lifecycle = installGracefulShutdown({
  logger,
  timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
  steps: [
    // 1) Deja de aceptar conexiones nuevas y espera a las preguntas en vuelo.
    { name: "cerrar el servidor HTTP", run: () => app.close() },
    // 2) Con nada en vuelo, libera los temporizadores del breaker.
    { name: "cerrar el breaker de fleet-api", run: () => Promise.resolve(fleet.shutdown()) },
  ],
});

try {
  await app.listen({ host: config.AGENT_HOST, port: config.AGENT_PORT });
  logger.info({ host: config.AGENT_HOST, port: config.AGENT_PORT, provider: config.AGENT_MODEL_PROVIDER }, "agent escuchando");
} catch (err) {
  logger.error({ err }, "No se pudo arrancar el agente");
  await lifecycle.shutdown("fallo de arranque", 1);
}
