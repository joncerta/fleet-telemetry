"use client";

import { FullPageMessage } from "../components/full-page-message";

/** Error no controlado de una ruta. No muestra el mensaje del error (podría arrastrar datos): solo un texto fijo y el reintento. */
export default function RouteError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <FullPageMessage title="Algo salió mal" description="No se pudo mostrar esta pantalla.">
      <button type="button" onClick={reset} className="mt-4 rounded-md bg-ink px-4 py-2 font-medium text-raised hover:bg-ink/90">
        Reintentar
      </button>
    </FullPageMessage>
  );
}
