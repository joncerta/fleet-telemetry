import { STATUS_LABELS, StatusGlyph } from "../../components/status";
import { VEHICLE_STATUSES } from "../../design/tokens";

const ZONE_LEGEND = [
  { label: "Zona crítica", swatch: "border-zone-critical bg-zone-critical/20" },
  { label: "Depósito", swatch: "border-zone-depot bg-zone-depot/15" },
  { label: "Cliente", swatch: "border-zone-customer bg-zone-customer/15" },
] as const;

/**
 * Leyenda del mapa: la forma y el color de cada estado, y los colores de zona (los mismos tokens que las capas). También dice si la capa
 * de vehículos todavía carga o no pudo dibujarse: un mapa sin vehículos nunca se muestra como si la flota estuviera vacía.
 */
export function MapLegend({ vehicles }: { vehicles: "loading" | "ready" | "error" }) {
  return (
    <div className="absolute left-3 top-3 max-w-56 rounded-lg border border-line bg-raised/95 px-3 py-2 text-xs shadow-sm">
      {/* Plegable (en móvil tapa buena parte del mapa); los avisos de la capa de vehículos quedan fuera, siempre visibles. */}
      <details open>
        <summary className="cursor-pointer font-semibold text-ink">Leyenda</summary>
        <ul className="mt-1 space-y-1">
          {VEHICLE_STATUSES.filter((status) => status !== "unknown").map((status) => (
            <li key={status} className="flex items-center gap-2 text-ink">
              <StatusGlyph status={status} className="size-3" />
              {STATUS_LABELS[status]}
            </li>
          ))}
          {ZONE_LEGEND.map((zone) => (
            <li key={zone.label} className="flex items-center gap-2 text-ink">
              <span aria-hidden="true" className={`size-3 rounded-sm border ${zone.swatch}`} />
              {zone.label}
            </li>
          ))}
        </ul>
      </details>
      {vehicles === "loading" && (
        <p role="status" className="mt-2 text-ink-muted">
          Cargando vehículos…
        </p>
      )}
      {vehicles === "error" && (
        <p role="alert" className="mt-2 text-danger">
          No se pudieron dibujar los vehículos en el mapa. La lista del panel tiene la misma información.
        </p>
      )}
    </div>
  );
}
