"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import { Map as MapLibreMap, NavigationControl, setWorkerUrl, type GeoJSONSource, type MapLayerMouseEvent } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { useServices } from "../../app-services/services-context";
import { logWarn } from "../../lib/log";
import { criticalZoneIdsOf } from "../fleet/vehicle-status";
import type { FleetStore } from "../fleet/fleet-store";
import {
  clusterCountLayer,
  clustersLayer,
  INITIAL_VIEW,
  LAYER_IDS,
  selectedFilter,
  selectedLayer,
  SOURCE_IDS,
  vehiclesLayer,
  vehiclesSource,
  zoneFillLayer,
  zoneLineLayer,
  zonesSource,
} from "./map-layers";
import { MapLegend } from "./MapLegend";
import { createLoadWatchdog, createRenderScheduler } from "./render-scheduler";
import { statusIcons } from "./status-icons";
import { toVehicleFeatures } from "./vehicle-features";
import { attachZoneDrawing, unlessDrawing } from "./zone-drawing-layer";

/**
 * Worker de MapLibre servido como archivo estático (lo copia `scripts/copy-maplibre-worker.mjs` desde la versión instalada): la URL por
 * defecto, relativa al módulo, no existe dentro del bundle de Next. Este módulo solo se carga en el cliente (`ssr: false`).
 */
const MAPLIBRE_WORKER_URL = "/vendor/maplibre/maplibre-gl-worker.mjs";
setWorkerUrl(MAPLIBRE_WORKER_URL);

/** `setData` a lo sumo cada 500 ms, con todos los eventos acumulados entre actualizaciones (apps/web/CLAUDE.md, regla 8). */
const RENDER_INTERVAL_MS = 500;
/** "Sin señal" cambia con el tiempo aunque no lleguen eventos: el mapa se recalcula al menos con este tick. */
const STATUS_TICK_MS = 30_000;
/** Si la capa de vehículos no termina de cargar en este tiempo (p. ej. el worker de MapLibre no arrancó), se dice en vez de callar. */
const VEHICLES_LOAD_TIMEOUT_MS = 20_000;

const EMPTY_COLLECTION = { type: "FeatureCollection" as const, features: [] };

export type MapState = "loading" | "ready" | "error";

/** Textos de MapLibre en español (las claves son las de su diccionario de UI). */
const MAP_LOCALE: Record<string, string> = {
  "Map.Title": "Mapa de la flota",
  "NavigationControl.ZoomIn": "Acercar",
  "NavigationControl.ZoomOut": "Alejar",
  "NavigationControl.ResetBearing": "Orientar al norte",
  "AttributionControl.ToggleAttribution": "Mostrar u ocultar la atribución",
};

/**
 * Mapa de la flota. Se crea UNA vez (efecto con ref) y se destruye con `map.remove()`. Solo en el cliente (lo carga `FleetMapPanel` con
 * `ssr: false`). Los vehículos son UNA fuente GeoJSON actualizada con `setData` desde el store (sin pasar por el render de React);
 * nunca un marker ni un componente por vehículo.
 */
export default function FleetMap({ styleUrl }: { styleUrl: string }) {
  const { fleetStore, zoneDrawingStore } = useServices();
  const containerRef = useRef<HTMLDivElement>(null);
  const [mapState, setMapState] = useState<MapState>("loading");
  /** La fuente de vehículos terminó de procesarse (lo hace el worker de MapLibre): solo entonces se ven en el mapa. */
  const [vehiclesState, setVehiclesState] = useState<MapState>("loading");
  /** Colocando puntos: se ve la cruz del centro (el punto que agrega "Agregar punto en el centro del mapa"). */
  const placingPoints = useStore(zoneDrawingStore, (state) => state.drawing.phase === "drawing");

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    let map: MapLibreMap;
    try {
      map = new MapLibreMap({
        container,
        style: styleUrl,
        center: INITIAL_VIEW.center,
        zoom: INITIAL_VIEW.zoom,
        // Atribución SIEMPRE visible (OpenFreeMap / OpenStreetMap): sin el modo compacto que la esconde tras un botón.
        attributionControl: { compact: false },
        // Textos de los controles y nombre accesible del lienzo, en español.
        locale: MAP_LOCALE,
      });
    } catch {
      // Sin WebGL (algunos navegadores o equipos): la lista de vehículos tiene la misma información.
      logWarn("No se pudo crear el mapa");
      queueMicrotask(() => setMapState("error"));
      return;
    }
    map.addControl(new NavigationControl({ showCompass: false }), "top-right");

    /** El estilo cargó (evento `load`): desde aquí un error es de un tile o de una capa, no "no hay mapa". */
    let styleLoaded = false;
    /** Fuentes y capas añadidas: se puede llamar a `setData`. */
    let loaded = false;
    let vehiclesLoaded = false;
    let renderedZones: FleetStore["zones"]["data"] = null;
    let criticalZoneIds = criticalZoneIdsOf(null);
    let renderedSelection: string | null = null;
    let detachZoneDrawing: (() => void) | null = null;

    const vehiclesSource$ = () => map.getSource<GeoJSONSource>(SOURCE_IDS.vehicles);
    const zonesSource$ = () => map.getSource<GeoJSONSource>(SOURCE_IDS.zones);

    const render = () => {
      const state = fleetStore.getState();
      if (state.zones.data !== renderedZones) {
        renderedZones = state.zones.data;
        criticalZoneIds = criticalZoneIdsOf(renderedZones);
        void zonesSource$()?.setData(renderedZones ?? EMPTY_COLLECTION);
      }
      const serverNowIso = new Date(Date.now() + state.serverOffsetMs).toISOString();
      void vehiclesSource$()?.setData(toVehicleFeatures(state.vehicles, serverNowIso, criticalZoneIds));
    };

    const scheduler = createRenderScheduler({ intervalMs: RENDER_INTERVAL_MS, tickMs: STATUS_TICK_MS, render });
    const scheduleRender = () => scheduler.request();
    const vehiclesWatchdog = createLoadWatchdog({
      timeoutMs: VEHICLES_LOAD_TIMEOUT_MS,
      onTimeout: () => {
        logWarn("La capa de vehículos del mapa no cargó");
        setVehiclesState("error");
      },
    });

    /** La selección (desde la lista o el mapa) se aplica al momento, sin esperar el lote: resalta y centra el vehículo. */
    const applySelection = () => {
      const { selectedVehicleId, vehicles } = fleetStore.getState();
      if (selectedVehicleId === renderedSelection) return;
      renderedSelection = selectedVehicleId;
      map.setFilter(LAYER_IDS.selected, selectedFilter(selectedVehicleId));
      const vehicle = selectedVehicleId === null ? undefined : vehicles[selectedVehicleId];
      if (vehicle !== undefined) map.easeTo({ center: [vehicle.lon, vehicle.lat], duration: 600 });
    };

    const unsubscribeStore = fleetStore.subscribe((state, previous) => {
      if (!loaded) return;
      if (state.selectedVehicleId !== previous.selectedVehicleId) applySelection();
      if (state.vehicles !== previous.vehicles || state.zones !== previous.zones || state.serverOffsetMs !== previous.serverOffsetMs) scheduleRender();
    });

    const onLoad = () => {
      styleLoaded = true;
      for (const { name, icon, pixelRatio } of statusIcons()) if (!map.hasImage(name)) map.addImage(name, icon, { pixelRatio });
      map.addSource(SOURCE_IDS.zones, zonesSource);
      map.addSource(SOURCE_IDS.vehicles, vehiclesSource);
      for (const layer of [zoneFillLayer, zoneLineLayer, clustersLayer, clusterCountLayer, selectedLayer, vehiclesLayer]) map.addLayer(layer);
      detachZoneDrawing = attachZoneDrawing(map, zoneDrawingStore);
      loaded = true;
      setMapState("ready");
      scheduler.start();
      applySelection();
      vehiclesWatchdog.start();
    };

    const onSourceData = map.on("sourcedata", (event) => {
      if (event.sourceId !== SOURCE_IDS.vehicles || !event.isSourceLoaded || vehiclesLoaded) return;
      vehiclesLoaded = true;
      vehiclesWatchdog.markLoaded();
      setVehiclesState("ready");
    });

    // Dibujando una zona, los clics agregan vértices: no seleccionan vehículos ni acercan clústeres (`unlessDrawing`).
    const onClick = map.on(
      "click",
      LAYER_IDS.vehicles,
      unlessDrawing(zoneDrawingStore, (event: MapLayerMouseEvent) => {
        const vehicleId: unknown = event.features?.[0]?.properties.vehicleId;
        if (typeof vehicleId === "string") fleetStore.getState().selectVehicle(vehicleId);
      }),
    );
    // Un clic en un clúster acerca el mapa hasta que se separa.
    const onClusterClick = map.on(
      "click",
      LAYER_IDS.clusters,
      unlessDrawing(zoneDrawingStore, (event: MapLayerMouseEvent) => {
        const clusterId: unknown = event.features?.[0]?.properties.cluster_id;
        if (typeof clusterId !== "number") return;
        const center = event.lngLat;
        vehiclesSource$()
          ?.getClusterExpansionZoom(clusterId)
          .then((zoom) => map.easeTo({ center, zoom }))
          .catch(() => logWarn("No se pudo expandir un clúster"));
      }),
    );
    const pointerOn = (layer: string) => [
      map.on(
        "mouseenter",
        layer,
        unlessDrawing(zoneDrawingStore, () => {
          map.getCanvas().style.cursor = "pointer";
        }),
      ),
      map.on(
        "mouseleave",
        layer,
        unlessDrawing(zoneDrawingStore, () => {
          map.getCanvas().style.cursor = "";
        }),
      ),
    ];
    const pointerSubscriptions = [...pointerOn(LAYER_IDS.vehicles), ...pointerOn(LAYER_IDS.clusters)];
    const onError = map.on("error", () => {
      // Sin detalles: la URL de un tile no sirve al usuario. Si el estilo no cargó, el mapa no existe: se dice.
      logWarn("Error del mapa", { styleLoaded });
      if (!styleLoaded) setMapState("error");
    });
    map.once("load", onLoad);

    return () => {
      unsubscribeStore();
      detachZoneDrawing?.();
      scheduler.dispose();
      vehiclesWatchdog.dispose();
      for (const subscription of [onClick, onClusterClick, onError, onSourceData, ...pointerSubscriptions]) subscription.unsubscribe();
      map.remove();
    };
  }, [fleetStore, zoneDrawingStore, styleUrl]);

  return (
    <div className="absolute inset-0">
      {/* Tamaño por h-full/w-full, no por posición: maplibre-gl.css le pone `position: relative` al contenedor y anularía un `absolute`. */}
      <div ref={containerRef} className="h-full w-full" aria-hidden={mapState === "error"} />
      {mapState === "ready" && <MapLegend vehicles={vehiclesState} />}
      {placingPoints && <CenterCross />}
      {mapState === "loading" && <MapMessage>Cargando mapa…</MapMessage>}
      {mapState === "error" && <MapMessage>No se pudo mostrar el mapa. La lista de vehículos del panel tiene la misma información.</MapMessage>}
    </div>
  );
}

/** Cruz fija en el centro del mapa mientras se dibuja: no recibe el puntero ni se anuncia (el botón del panel lo explica). */
function CenterCross() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <span className="absolute h-6 w-0.5 bg-focus" />
      <span className="absolute h-0.5 w-6 bg-focus" />
    </div>
  );
}

export function MapMessage({ children }: { children: string }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-canvas/80 p-6">
      <p role="status" className="max-w-xs text-center text-ink-muted">
        {children}
      </p>
    </div>
  );
}
