"use client";

import { useEffect } from "react";
import { useServices } from "../../app-services/services-context";
import { AlertsPanel } from "../alerts/AlertsPanel";
import { AuthGate } from "../auth/AuthGate";
import { ChatDock } from "../chat/ChatDock";
import { FleetMapPanel } from "../map/FleetMapPanel";
import { PairingPanel } from "../pairing/PairingPanel";
import { StoppedPanel } from "../stopped/StoppedPanel";
import { KpiPanel } from "../summary/KpiPanel";
import { UsersPanel } from "../users/UsersPanel";
import { ZonesPanel } from "../zones/ZonesPanel";
import { VehiclesPanel } from "../vehicles/VehiclesPanel";
import { DashboardHeader } from "./DashboardHeader";

export function DashboardScreen() {
  return (
    <AuthGate>
      <Dashboard />
    </AuthGate>
  );
}

/** Mapa a pantalla completa, panel lateral (KPIs, alertas, detenidos, vehículos, vinculación) y chat plegable. */
function Dashboard() {
  const { fleetSync } = useServices();

  // La ÚNICA conexión SSE de la app: se adquiere al montar el dashboard y se suelta al desmontarlo.
  useEffect(() => fleetSync.acquire(), [fleetSync]);

  return (
    <div className="flex h-dvh flex-col bg-canvas">
      <DashboardHeader />
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <main className="relative h-96 shrink-0 lg:h-auto lg:flex-1" aria-label="Mapa">
          <FleetMapPanel />
        </main>
        <aside aria-label="Panel de la flota" className="min-h-0 flex-1 overflow-y-auto border-line bg-surface lg:w-96 lg:flex-none lg:border-l">
          <KpiPanel />
          <AlertsPanel />
          <StoppedPanel />
          <VehiclesPanel />
          <ZonesPanel />
          <PairingPanel />
          <UsersPanel />
        </aside>
      </div>
      <ChatDock />
    </div>
  );
}
