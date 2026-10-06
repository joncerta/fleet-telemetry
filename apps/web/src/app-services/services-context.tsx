"use client";

import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { useStore } from "zustand";
import { publicEnv } from "../config/public-env";
import type { SessionStore } from "../features/auth/session-store";
import type { FleetStore } from "../features/fleet/fleet-store";
import { subscribeThrottled } from "../features/fleet/throttled-subscription";
import { serverNowMs } from "../lib/time/server-clock";
import { createAppServices, type AppServices } from "./app-services";

const ServicesContext = createContext<AppServices | null>(null);

/**
 * Crea los servicios UNA vez por montaje del árbol (no a nivel de módulo: en el servidor un singleton se compartiría entre peticiones).
 * Crearlos no abre conexiones: el stream se abre al adquirir `fleetSync` en el dashboard.
 */
export function AppServicesProvider({ children }: { children: ReactNode }) {
  const [services] = useState(() => createAppServices(publicEnv));
  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>;
}

export function useServices(): AppServices {
  const services = useContext(ServicesContext);
  if (services === null) throw new Error("useServices fuera de AppServicesProvider");
  return services;
}

/** Selector fino sobre el store de la flota (un componente nunca lee el store completo). */
export function useFleet<T>(selector: (state: FleetStore) => T): T {
  return useStore(useServices().fleetStore, selector);
}

/** Cadencia de las listas del panel: la misma del `setData` del mapa (apps/web/CLAUDE.md, regla 8). */
export const PANEL_THROTTLE_MS = 500;

/**
 * Como `useFleet`, pero el valor se actualiza a lo sumo cada `intervalMs`: las listas largas no se recalculan con cada lote de eventos.
 * `selector` debe ser estable (función de módulo o `useCallback`); `equals` evita renderizar si el resultado es equivalente.
 */
export function useThrottledFleet<T>(selector: (state: FleetStore) => T, intervalMs = PANEL_THROTTLE_MS, equals: (a: T, b: T) => boolean = Object.is): T {
  const { fleetStore } = useServices();
  const [value, setValue] = useState(() => selector(fleetStore.getState()));
  useEffect(() => subscribeThrottled(fleetStore, selector, intervalMs, setValue, equals), [fleetStore, selector, intervalMs, equals]);
  return value;
}

export function useSession<T>(selector: (state: SessionStore) => T): T {
  return useStore(useServices().sessionStore, selector);
}

/**
 * Hora del SERVIDOR estimada, que avanza cada `tickMs` (30 s por defecto): "sin señal" y "minutos detenido" cambian aunque no lleguen
 * eventos. `null` en el primer render (servidor e hidratación): nunca se calcula con un reloj que no es el del navegador del usuario.
 */
export function useServerNow(tickMs = 30_000): number | null {
  const offset = useFleet((state) => state.serverOffsetMs);
  const subscribe = useCallback(
    (onTick: () => void) => {
      const id = setInterval(onTick, tickMs);
      return () => clearInterval(id);
    },
    [tickMs],
  );
  // Cuantizado al segundo: el snapshot debe ser estable entre dos lecturas seguidas de React.
  const clientNow = useSyncExternalStore(subscribe, readClientSecond, readNothingOnServer);
  return clientNow === null ? null : serverNowMs(offset, clientNow);
}

const readClientSecond = (): number => Math.floor(Date.now() / 1_000) * 1_000;
const readNothingOnServer = (): null => null;
