import type { AddLayerObject, Map as MapLibreMap } from "maplibre-gl";
import { mapMarker, palette, vehicleStatusColors, zoneKindStyles as zone } from "../../design/tokens";
import { ICON_PREFIX } from "./status-icons";

export const SOURCE_IDS = { zones: "fleet-zones", vehicles: "fleet-vehicles" } as const;
export const LAYER_IDS = {
  zoneFill: "fleet-zones-fill",
  zoneLine: "fleet-zones-line",
  clusters: "fleet-vehicle-clusters",
  clusterCount: "fleet-vehicle-cluster-count",
  selected: "fleet-vehicle-selected",
  vehicles: "fleet-vehicles-icons",
} as const;

/** Centro inicial: Bogotá, en orden `[lng, lat]` (apps/web/CLAUDE.md). */
export const INITIAL_VIEW = { center: [-74.1, 4.65] as [number, number], zoom: 11 };

/** Por debajo de este zoom los vehículos se agrupan (vista de país o de región); desde el zoom inicial (11) se ven uno a uno. */
export const CLUSTER_MAX_ZOOM = 10;

type SourceSpec = Parameters<MapLibreMap["addSource"]>[1];
type LayerFilter = NonNullable<Extract<AddLayerObject, { type: "circle" }>["filter"]>;

const EMPTY_COLLECTION = { type: "FeatureCollection" as const, features: [] };

export const zonesSource: SourceSpec = { type: "geojson", data: EMPTY_COLLECTION };

/**
 * Fuente ÚNICA de los vehículos, con clustering para flotas grandes. Cada clúster suma cuántos de sus vehículos están detenidos en
 * zona crítica (`critical`): así un clúster no esconde lo urgente.
 */
export const vehiclesSource: SourceSpec = {
  type: "geojson",
  data: EMPTY_COLLECTION,
  cluster: true,
  clusterMaxZoom: CLUSTER_MAX_ZOOM,
  clusterRadius: 40,
  clusterProperties: { critical: ["+", ["case", ["==", ["get", "status"], "stopped_critical"], 1, 0]] },
};

const NOT_CLUSTER: LayerFilter = ["!", ["has", "point_count"]];

// Colores de zona por `kind`, siempre de los tokens (el mapa no entiende clases de Tailwind). `unknown` es el valor por defecto.
export const zoneFillLayer: AddLayerObject = {
  id: LAYER_IDS.zoneFill,
  type: "fill",
  source: SOURCE_IDS.zones,
  paint: {
    "fill-color": ["match", ["get", "kind"], "critical", zone.critical.fill, "depot", zone.depot.fill, "customer", zone.customer.fill, zone.unknown.fill],
    "fill-opacity": [
      "match",
      ["get", "kind"],
      "critical",
      zone.critical.fillOpacity,
      "depot",
      zone.depot.fillOpacity,
      "customer",
      zone.customer.fillOpacity,
      zone.unknown.fillOpacity,
    ],
  },
};

export const zoneLineLayer: AddLayerObject = {
  id: LAYER_IDS.zoneLine,
  type: "line",
  source: SOURCE_IDS.zones,
  paint: {
    "line-color": ["match", ["get", "kind"], "critical", zone.critical.line, "depot", zone.depot.line, "customer", zone.customer.line, zone.unknown.line],
    "line-width": 1.5,
  },
};

/** Clústeres: rojos si contienen algún vehículo detenido en zona crítica; tamaño según cuántos agrupan. */
export const clustersLayer: AddLayerObject = {
  id: LAYER_IDS.clusters,
  type: "circle",
  source: SOURCE_IDS.vehicles,
  filter: ["has", "point_count"],
  paint: {
    "circle-color": ["case", [">", ["get", "critical"], 0], vehicleStatusColors.stopped_critical, palette.ink],
    "circle-radius": ["step", ["get", "point_count"], 14, 10, 18, 50, 24],
    "circle-stroke-color": mapMarker.halo,
    "circle-stroke-width": 2,
  },
};

export const clusterCountLayer: AddLayerObject = {
  id: LAYER_IDS.clusterCount,
  type: "symbol",
  source: SOURCE_IDS.vehicles,
  filter: ["has", "point_count"],
  layout: { "text-field": ["get", "point_count_abbreviated"], "text-font": ["Noto Sans Regular"], "text-size": 12, "text-allow-overlap": true },
  paint: { "text-color": palette.raised },
};

/** Filtro del anillo de selección: solo el vehículo seleccionado (ninguno con `null`), nunca un clúster. */
export const selectedFilter = (vehicleId: string | null): LayerFilter => ["all", NOT_CLUSTER, ["==", ["get", "vehicleId"], vehicleId ?? ""]];

/** Anillo del vehículo seleccionado (se mueve con `setFilter(selectedFilter(id))`). */
export const selectedLayer: AddLayerObject = {
  id: LAYER_IDS.selected,
  type: "circle",
  source: SOURCE_IDS.vehicles,
  filter: selectedFilter(null),
  paint: {
    "circle-radius": mapMarker.iconSize * 0.85,
    "circle-opacity": 0,
    "circle-stroke-color": mapMarker.selectedRing,
    "circle-stroke-width": 3,
  },
};

/** Vehículos: un ícono por estado (forma + color), con lo más urgente encima. */
export const vehiclesLayer: AddLayerObject = {
  id: LAYER_IDS.vehicles,
  type: "symbol",
  source: SOURCE_IDS.vehicles,
  filter: NOT_CLUSTER,
  layout: {
    "icon-image": ["concat", ICON_PREFIX, ["get", "status"]],
    "icon-allow-overlap": true,
    "icon-ignore-placement": true,
    "symbol-sort-key": ["get", "rank"],
  },
};
