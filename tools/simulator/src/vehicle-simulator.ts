import { telemetryPointSchema, type TelemetryPoint } from "@fleet/contracts";
import { zoneCenter, type SeedVehicle, type SeedZone } from "@fleet/dev-data";
import type { City } from "./cities.js";
import { offsetLonLat } from "./geo.js";
import type { Rng } from "./rng.js";
import { createRouteWalker } from "./route.js";

/**
 * Comportamientos de la demo, por tenant y por orden de vehículo:
 * - `critical_stop` (los 2 primeros): llegan a una zona crítica sembrada, se detienen y siguen reportando detenidos;
 * - `mocked` (el 3.º): se mueve con `mocked: true` (alerta `mocked_location`);
 * - `silent` (el 4.º): se mueve y, pasado un tiempo, deja de enviar (aparece "sin señal" a los 5 minutos);
 * - `moving`: el resto, en movimiento.
 */
export type Behavior = "moving" | "critical_stop" | "mocked" | "silent";

export interface VehiclePlan {
  vehicle: SeedVehicle;
  behavior: Behavior;
  /** Zona crítica donde se detiene (solo `critical_stop`). */
  zone?: SeedZone;
}

/** Asigna los comportamientos por tenant, en el orden en que llegan los vehículos de cada uno. */
export function planFleet(vehicles: readonly SeedVehicle[], zones: readonly SeedZone[]): VehiclePlan[] {
  const seenByTenant = new Map<string, number>();
  return vehicles.map((vehicle) => {
    const index = seenByTenant.get(vehicle.tenantId) ?? 0;
    seenByTenant.set(vehicle.tenantId, index + 1);
    const critical = zones.filter((zone) => zone.tenantId === vehicle.tenantId && zone.kind === "critical").sort((a, b) => a.zoneId.localeCompare(b.zoneId));
    const zone = critical[index % Math.max(critical.length, 1)];
    if (index < 2 && zone !== undefined) return { vehicle, behavior: "critical_stop", zone };
    if (index === 2) return { vehicle, behavior: "mocked" };
    if (index === 3) return { vehicle, behavior: "silent" };
    return { vehicle, behavior: "moving" };
  });
}

/** Un vehículo simulado. */
export interface VehicleSimulator {
  readonly plan: VehiclePlan;
  /**
   * Historial de la parada (solo `critical_stop`; vacío en los demás): puntos de 25 a 30 minutos atrás hasta ahora, en orden
   * de `recordedAt`, para que la pregunta de "detenidos más de 20 minutos" tenga respuesta en segundos.
   */
  history(now: Date): TelemetryPoint[];
  /** El punto que captura el "fix" en `recordedAt` (debe ser posterior al anterior), o `null` si el vehículo dejó de enviar. */
  point(recordedAt: Date): TelemetryPoint | null;
}

export interface VehicleSimulatorOptions {
  plan: VehiclePlan;
  city: City;
  /** RNG propio del vehículo (`rng.fork(vehicleId)`): su ruta no depende de los demás. */
  rng: Rng;
  /** Momento de arranque de la simulación, para `silent`. */
  startedAt: Date;
  /** Cuánto envía un `silent` antes de callar, en ms. */
  silentAfterMs: number;
  /** Generador de `eventId`. Por defecto, UUID aleatorios en el llamador; los tests pasan uno fijo. */
  newEventId: () => string;
}

/** Por encima de este radio de precisión (m) el dispositivo marca `lowAccuracy`. */
const LOW_ACCURACY_THRESHOLD_M = 30;
const STOPPED_POINT_EVERY_MS = 60_000;
const GPS_NOISE_M = 2.5;
/** Cada cuánto se detiene un vehículo en movimiento en una esquina (semáforo) y por cuánto tiempo. */
const RED_LIGHT_CHANCE = 0.08;
const RED_LIGHT_SECONDS = { min: 10, max: 40 } as const;

export function createVehicleSimulator(options: VehicleSimulatorOptions): VehicleSimulator {
  const { plan, city, rng, startedAt, silentAfterMs, newEventId } = options;

  const build = (fields: {
    recordedAt: Date;
    lon: number;
    lat: number;
    speedMps: number;
    headingDeg: number;
    accuracyM: number;
    mocked: boolean;
  }): TelemetryPoint =>
    // Se valida contra el contrato antes de enviarlo: un punto mal formado es un bug del simulador, no algo para el gateway.
    telemetryPointSchema.parse({
      eventId: newEventId(),
      vehicleId: plan.vehicle.id,
      recordedAt: fields.recordedAt.toISOString(),
      lon: fields.lon,
      lat: fields.lat,
      speedMps: fields.speedMps,
      headingDeg: fields.headingDeg % 360,
      accuracyM: fields.accuracyM,
      altitudeM: city.altitudeM + rng.normal(3),
      mocked: fields.mocked,
      lowAccuracy: fields.accuracyM > LOW_ACCURACY_THRESHOLD_M,
    });

  const accuracy = (): number => (rng.chance(0.03) ? rng.range(35, 80) : rng.range(4, 15));
  const noisy = (lon: number, lat: number): [number, number] => offsetLonLat(lon, lat, rng.normal(GPS_NOISE_M), rng.normal(GPS_NOISE_M));

  if (plan.behavior === "critical_stop" && plan.zone !== undefined) {
    // Dentro de la zona (de ~500 m): el ancla se corre hasta 50 m del centro, y el ruido de GPS es de pocos metros.
    const [centerLon, centerLat] = zoneCenter(plan.zone);
    const [anchorLon, anchorLat] = offsetLonLat(centerLon, centerLat, rng.range(-50, 50), rng.range(-50, 50));
    const stopped = (recordedAt: Date): TelemetryPoint => {
      const [lon, lat] = noisy(anchorLon, anchorLat);
      return build({ recordedAt, lon, lat, speedMps: 0, headingDeg: 90, accuracyM: rng.range(5, 12), mocked: false });
    };
    return {
      plan,
      history(now) {
        const stopStartedAt = now.getTime() - rng.range(25, 30) * 60_000;
        // Tres puntos de aproximación desde el oeste, en movimiento, y luego la parada.
        const approach = [60, 35, 12].map((distanceM, index) => {
          const [lon, lat] = offsetLonLat(anchorLon, anchorLat, -distanceM, 0);
          return build({
            recordedAt: new Date(stopStartedAt - (3 - index) * 10_000),
            lon,
            lat,
            speedMps: rng.range(3, 6),
            headingDeg: 90,
            accuracyM: rng.range(5, 12),
            mocked: false,
          });
        });
        const stops: TelemetryPoint[] = [];
        // El último punto queda al menos un minuto antes de "ahora": el primero en vivo llega después.
        for (let at = stopStartedAt; at < now.getTime() - STOPPED_POINT_EVERY_MS; at += STOPPED_POINT_EVERY_MS) {
          stops.push(stopped(new Date(at)));
        }
        return [...approach, ...stops];
      },
      point: stopped,
    };
  }

  // Los demás se mueven por la cuadrícula de la ciudad (`silent` y `mocked` también).
  const walker = createRouteWalker(city, rng);
  const cruiseMps = rng.range(6, 13);
  let lastAtMs: number | null = null;
  let redLightLeftS = 0;
  const mocked = plan.behavior === "mocked";

  return {
    plan,
    history: () => [],
    point(recordedAt) {
      const atMs = recordedAt.getTime();
      if (plan.behavior === "silent" && atMs - startedAt.getTime() >= silentAfterMs) return null;
      const dtS = lastAtMs === null ? 0 : Math.max(0, (atMs - lastAtMs) / 1000);
      lastAtMs = atMs;

      let speedMps = 0;
      if (redLightLeftS > 0) {
        redLightLeftS = Math.max(0, redLightLeftS - dtS);
      } else {
        speedMps = Math.max(1, cruiseMps + rng.normal(1.5));
        const corners = walker.advance(speedMps * dtS);
        if (corners > 0 && rng.chance(RED_LIGHT_CHANCE)) redLightLeftS = rng.range(RED_LIGHT_SECONDS.min, RED_LIGHT_SECONDS.max);
      }
      const { lon, lat, headingDeg } = walker.position();
      const [noisyLon, noisyLat] = noisy(lon, lat);
      return build({ recordedAt, lon: noisyLon, lat: noisyLat, speedMps, headingDeg, accuracyM: accuracy(), mocked });
    },
  };
}
