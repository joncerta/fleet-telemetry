"use client";

import dynamic from "next/dynamic";
import { useServices } from "../../app-services/services-context";

// MapLibre necesita `window` y WebGL: se carga solo en el cliente, nunca en el render del servidor.
const FleetMap = dynamic(() => import("./FleetMap"), {
  ssr: false,
  loading: () => (
    <div className="absolute inset-0 flex items-center justify-center bg-canvas">
      <p role="status" className="text-ink-muted">
        Cargando mapa…
      </p>
    </div>
  ),
});

export function FleetMapPanel() {
  const { env } = useServices();
  return <FleetMap styleUrl={env.mapStyleUrl} />;
}
