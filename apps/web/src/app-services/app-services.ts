import type { StoreApi } from "zustand/vanilla";
import type { PublicEnv } from "../config/public-env";
import { createSessionStore, type SessionStore } from "../features/auth/session-store";
import { createFleetStore, type FleetStore } from "../features/fleet/fleet-store";
import { createFleetSync } from "../features/fleet/fleet-sync";
import { browserEventSource, createFleetStream, type SessionProbe } from "../features/stream/fleet-stream-client";
import { createAgentApi, type AgentApi } from "../lib/api/agent-api";
import { createFleetApi, FLEET_API_PATHS, type FleetApi } from "../lib/api/fleet-api";
import { createHttpClient, UnauthorizedError } from "../lib/api/http-client";
import { logWarn } from "../lib/log";
import { createSharedResource, type SharedResource } from "../lib/shared-resource";

/**
 * Latido del stream de fleet-api (`SSE_HEARTBEAT_MS`, 15 s por defecto). El contrato no lo expone: si el backend lo cambia, hay que
 * cambiarlo aquí también (ver los requisitos para el backend en el resumen del cambio).
 */
export const SSE_HEARTBEAT_MS = 15_000;

/** Margen para que el doble montaje de StrictMode no cierre y reabra la conexión SSE. */
const STREAM_RELEASE_DELAY_MS = 50;

export interface AppServices {
  env: PublicEnv;
  api: FleetApi;
  /** El agente IA (`NEXT_PUBLIC_AGENT_URL`): misma cookie de sesión que fleet-api. */
  agentApi: AgentApi;
  fleetStore: StoreApi<FleetStore>;
  sessionStore: StoreApi<SessionStore>;
  /** La ÚNICA conexión SSE de la app (con conteo de referencias). */
  fleetSync: SharedResource;
  /** Cierra la sesión: corta el stream, borra los datos del tenant y avisa a la API. */
  signOut(): Promise<void>;
}

/** Composition root del cliente: arma la API, los stores y el sincronizador. Sin efectos hasta que alguien adquiere `fleetSync`. */
export function createAppServices(env: PublicEnv): AppServices {
  const sessionStore = createSessionStore();
  const fleetStore = createFleetStore();
  const http = createHttpClient({ baseUrl: env.fleetApiUrl, logError: logWarn });

  // Sin sesión (401 en una llamada o en el stream): se corta el stream y se borran los datos ANTES de ir al login.
  const endSession = () => {
    fleetSync.dispose();
    fleetStore.getState().reset();
    sessionStore.getState().signedOut();
  };

  const api = createFleetApi(http, endSession);
  const agentApi = createAgentApi(createHttpClient({ baseUrl: env.agentUrl, logError: logWarn }), endSession);

  const probeSession: SessionProbe = async () => {
    try {
      await api.getSession();
      return "authenticated";
    } catch (error) {
      return error instanceof UnauthorizedError ? "unauthorized" : "unknown";
    }
  };

  const fleetSync: SharedResource = createSharedResource(
    () =>
      createFleetSync({
        api,
        store: fleetStore,
        onUnauthorized: endSession,
        log: logWarn,
        openStream: (callbacks) =>
          createFleetStream(
            {
              url: `${env.fleetApiUrl}${FLEET_API_PATHS.stream}`,
              createEventSource: browserEventSource,
              probeSession,
              heartbeatMs: SSE_HEARTBEAT_MS,
              log: logWarn,
            },
            callbacks,
          ),
      }),
    STREAM_RELEASE_DELAY_MS,
  );

  return {
    env,
    api,
    agentApi,
    fleetStore,
    sessionStore,
    fleetSync,
    async signOut() {
      fleetSync.dispose();
      try {
        await api.logout();
      } catch {
        logWarn("No se pudo cerrar la sesión en el servidor");
      }
      fleetStore.getState().reset();
      sessionStore.getState().signedOut();
    },
  };
}
