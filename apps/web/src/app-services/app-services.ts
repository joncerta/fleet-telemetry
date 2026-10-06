import type { Session } from "@fleet/contracts";
import type { StoreApi } from "zustand/vanilla";
import type { PublicEnv } from "../config/public-env";
import { createSessionStore, type SessionStore } from "../features/auth/session-store";
import { createFleetStore, type FleetStore } from "../features/fleet/fleet-store";
import { createZoneDrawingStore, type ZoneDrawingStore } from "../features/zones/zone-drawing-store";
import { createFleetSync } from "../features/fleet/fleet-sync";
import { browserEventSource, createFleetStream, type SessionProbe } from "../features/stream/fleet-stream-client";
import { createAgentApi, type AgentApi } from "../lib/api/agent-api";
import { createFleetApi, FLEET_API_PATHS, type FleetApi } from "../lib/api/fleet-api";
import { browserStorage, clearPanelPreferences } from "../components/panel-state";
import { createHttpClient, UnauthorizedError } from "../lib/api/http-client";
import { logWarn } from "../lib/log";
import { createSharedResource, type SharedResource } from "../lib/shared-resource";

/**
 * Latido del stream de fleet-api (`SSE_HEARTBEAT_MS`, 15 s por defecto). El contrato no lo expone: si el backend lo cambia, hay que
 * cambiarlo aquí también (ver los requisitos para el backend en el resumen del cambio).
 */
export const SSE_HEARTBEAT_MS = 15_000;

/** Canal entre pestañas del mismo navegador: comparten la cookie de sesión, así que un cambio de sesión en una afecta a todas. */
export const SESSION_CHANNEL_NAME = "fleet-session";
/** Espera máxima de la consulta de sesión (probe del stream y verificación de identidad): sin respuesta se trata como "no se sabe". */
const SESSION_CHECK_TIMEOUT_MS = 5_000;

/** Lo que se necesita de `BroadcastChannel` (los tests usan uno falso). */
export interface SessionChannelLike {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  close(): void;
}

export interface AppServicesOptions {
  /** Abre el canal entre pestañas; `null` si no hay (servidor, navegador sin `BroadcastChannel`). Por defecto, el del navegador. */
  createSessionChannel?: (name: string) => SessionChannelLike | null;
}

const browserSessionChannel = (name: string): SessionChannelLike | null =>
  typeof window === "undefined" || typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(name);

const SESSION_CHANGED = { type: "session-changed" } as const;
const isSessionChanged = (data: unknown): boolean => typeof data === "object" && data !== null && "type" in data && data.type === SESSION_CHANGED.type;

/** Misma persona en el mismo tenant (la identidad que importa para no mezclar datos). */
export const sameIdentity = (a: Session, b: Session): boolean => a.user.userId === b.user.userId && a.tenant.tenantId === b.tenant.tenantId;

/** Margen para que el doble montaje de StrictMode no cierre y reabra la conexión SSE. */
const STREAM_RELEASE_DELAY_MS = 50;

export interface AppServices {
  env: PublicEnv;
  api: FleetApi;
  /** El agente IA (`NEXT_PUBLIC_AGENT_URL`): misma cookie de sesión que fleet-api. */
  agentApi: AgentApi;
  fleetStore: StoreApi<FleetStore>;
  sessionStore: StoreApi<SessionStore>;
  /** Dibujo de una zona en curso: lo comparten el mapa (clics) y el panel "Zonas". */
  zoneDrawingStore: StoreApi<ZoneDrawingStore>;
  /** La ÚNICA conexión SSE de la app (con conteo de referencias). */
  fleetSync: SharedResource;
  /** Registra el login exitoso (identidad en memoria) y avisa a las demás pestañas para que no sigan con la sesión anterior. */
  signIn(session: Session): void;
  /** Cierra la sesión: corta el stream, borra los datos del tenant y avisa a la API. */
  signOut(): Promise<void>;
}

/** Composition root del cliente: arma la API, los stores y el sincronizador. Sin efectos hasta que alguien adquiere `fleetSync`. */
export function createAppServices(env: PublicEnv, options: AppServicesOptions = {}): AppServices {
  const sessionStore = createSessionStore();
  const fleetStore = createFleetStore();
  const zoneDrawingStore = createZoneDrawingStore();
  const http = createHttpClient({ baseUrl: env.fleetApiUrl, logError: logWarn });

  // Sin sesión (401 en una llamada o en el stream): se corta el stream y se borran los datos ANTES de ir al login.
  const endSession = () => {
    fleetSync.dispose();
    fleetStore.getState().reset();
    zoneDrawingStore.getState().cancel();
    sessionStore.getState().signedOut();
  };

  const api = createFleetApi(http, endSession);
  const agentApi = createAgentApi(createHttpClient({ baseUrl: env.agentUrl, logError: logWarn }), endSession);

  const sessionChannel = (options.createSessionChannel ?? browserSessionChannel)(SESSION_CHANNEL_NAME);
  // Otra pestaña cerró sesión o entró (quizá otro usuario, de otro tenant): esta deja de mostrar datos y va al login.
  if (sessionChannel !== null) {
    sessionChannel.onmessage = (event) => {
      if (isSessionChanged(event.data)) endSession();
    };
  }
  const announceSessionChange = () => sessionChannel?.postMessage(SESSION_CHANGED);

  /**
   * Con cada snapshot (también el de una reconexión, que ya viaja con la cookie ACTUAL) se confirma que la identidad sigue siendo la
   * misma: si cambió el tenant o el usuario, o ya no hay sesión, se borra todo y se va al login.
   */
  const verifyIdentity = () => {
    if (sessionStore.getState().session === null) return;
    api.getSession(AbortSignal.timeout(SESSION_CHECK_TIMEOUT_MS)).then(
      (current) => {
        const known = sessionStore.getState().session;
        if (known !== null && !sameIdentity(known, current)) endSession();
      },
      (error: unknown) => {
        if (error instanceof UnauthorizedError) endSession();
      },
    );
  };

  const probeSession: SessionProbe = async () => {
    try {
      await api.getSession(AbortSignal.timeout(SESSION_CHECK_TIMEOUT_MS));
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
        verifyIdentity,
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
    zoneDrawingStore,
    fleetSync,
    signIn(session) {
      sessionStore.getState().signedIn(session);
      announceSessionChange();
    },
    async signOut() {
      fleetSync.dispose();
      try {
        await api.logout();
      } catch {
        logWarn("No se pudo cerrar la sesión en el servidor");
      }
      fleetStore.getState().reset();
      zoneDrawingStore.getState().cancel();
      // Cierre explícito (puede ser un equipo compartido): no quedan preferencias de la interfaz del usuario.
      clearPanelPreferences(browserStorage());
      sessionStore.getState().signedOut();
      announceSessionChange();
    },
  };
}
