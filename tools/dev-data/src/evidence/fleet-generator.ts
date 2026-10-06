// Generador determinista de datos sintéticos para `pnpm db:evidence`. Puro: sin red, sin DB y sin reloj (el instante final entra
// como argumento). Misma semilla y misma configuración, mismos puntos.
//
// Coordenadas siempre en orden [longitud, latitud] (regla 13). Todo cae dentro de Colombia (`COLOMBIA_BBOX`).

export const COLOMBIA_BBOX = { minLon: -79.1, maxLon: -66.8, minLat: -4.3, maxLat: 13.4 } as const;

export type LonLat = readonly [lon: number, lat: number];

interface City {
  readonly name: string;
  readonly center: LonLat;
  readonly altitudeM: number;
}

const BOGOTA: City = { name: "Bogotá", center: [-74.0721, 4.711], altitudeM: 2600 };
const MEDELLIN: City = { name: "Medellín", center: [-75.5636, 6.2476], altitudeM: 1500 };
const CALI: City = { name: "Cali", center: [-76.532, 3.4516], altitudeM: 1000 };
const BARRANQUILLA: City = { name: "Barranquilla", center: [-74.7813, 10.9685], altitudeM: 20 };

/** Dos tenants; cada uno opera en dos ciudades. */
const TENANT_CITIES: readonly (readonly City[])[] = [
  [BARRANQUILLA, MEDELLIN],
  [BOGOTA, CALI],
];
export const TENANT_COUNT = TENANT_CITIES.length;

/** Medio lado, en grados, de la caja en la que se mueve un vehículo alrededor del centro de su ciudad. */
const CITY_HALF_BOX_DEG = 0.25;
const METERS_PER_DEG_LAT = 111_320;

export interface GeneratorConfig {
  readonly seed: number;
  readonly vehicles: number;
  readonly days: number;
  readonly intervalSeconds: number;
  /** Instante (exclusivo) en que termina el dataset. Entra como argumento para que el generador no lea el reloj. */
  readonly endAt: Date;
}

/** mulberry32: PRNG de 32 bits, suficiente y reproducible. */
export interface Rng {
  next(): number;
  uint32(): number;
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const uint32 = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
  return { uint32, next: () => uint32() / 4_294_967_296 };
}

/** Semilla de un flujo independiente: mezcla la semilla global con una etiqueta numérica (vehículo, zonas...). */
function subSeed(seed: number, stream: number): number {
  return (Math.imul(seed >>> 0, 0x9e3779b1) ^ Math.imul(stream + 1, 0x85ebca6b)) >>> 0;
}

function uuidFromWords(a: number, b: number, c: number, d: number): string {
  const hex = [a, b, c, d].map((w) => (w >>> 0).toString(16).padStart(8, "0")).join("");
  // Versión 4 y variante RFC 4122, para que `z.uuid()` y la columna `uuid` lo acepten.
  const variant = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function uuidFrom(rng: Rng): string {
  return uuidFromWords(rng.uint32(), rng.uint32(), rng.uint32(), rng.uint32());
}

export interface PlannedTenant {
  readonly id: string;
  readonly name: string;
  readonly index: number;
}

export interface PlannedVehicle {
  readonly index: number;
  readonly id: string;
  readonly deviceId: string;
  readonly tenantId: string;
  readonly tenantIndex: number;
  readonly plate: string;
  readonly city: City;
  /** Desfase, en segundos, del primer punto del vehículo dentro del intervalo. */
  readonly offsetSeconds: number;
}

export interface FleetPlan {
  readonly tenants: readonly PlannedTenant[];
  readonly vehicles: readonly PlannedVehicle[];
}

export function planFleet(config: Pick<GeneratorConfig, "seed" | "vehicles" | "intervalSeconds">): FleetPlan {
  const tenantRng = createRng(subSeed(config.seed, 0));
  const tenants = Array.from({ length: TENANT_COUNT }, (_, index): PlannedTenant => ({ id: uuidFrom(tenantRng), name: `Evidencia ${index + 1}`, index }));
  const vehicles = Array.from({ length: config.vehicles }, (_, index): PlannedVehicle => {
    const rng = createRng(subSeed(config.seed, 1 + index));
    const tenantIndex = index % TENANT_COUNT;
    const cities = TENANT_CITIES[tenantIndex] ?? [];
    return {
      index,
      id: uuidFrom(rng),
      deviceId: uuidFrom(rng),
      tenantId: tenants[tenantIndex]?.id ?? "",
      tenantIndex,
      plate: `EV${String(index).padStart(5, "0")}`,
      city: cities[Math.floor(index / TENANT_COUNT) % cities.length] ?? BOGOTA,
      offsetSeconds: Math.floor(rng.next() * config.intervalSeconds),
    };
  });
  return { tenants, vehicles };
}

export interface SyntheticPoint {
  readonly eventId: string;
  readonly tenantId: string;
  readonly vehicleId: string;
  readonly deviceId: string;
  readonly recordedAt: Date;
  readonly receivedAt: Date;
  readonly lon: number;
  readonly lat: number;
  readonly speedMps: number | null;
  readonly headingDeg: number;
  readonly accuracyM: number;
  readonly altitudeM: number;
  readonly mocked: boolean;
  readonly lowAccuracy: boolean;
}

export interface FinalVehicleState {
  readonly vehicle: PlannedVehicle;
  readonly point: SyntheticPoint;
  readonly movement: "moving" | "stopped";
  readonly stoppedSince: Date | null;
}

const round6 = (value: number): number => Math.round(value * 1e6) / 1e6;
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** Recorrido de un vehículo: avanza con rumbo y velocidad, se detiene de vez en cuando y rebota en la caja de su ciudad. */
export class VehicleSimulator {
  private readonly rng: Rng;
  private lon: number;
  private lat: number;
  private headingRad: number;
  private speed = 8;
  private stopTicksLeft = 0;
  private stoppedSince: Date | null = null;
  private last: SyntheticPoint | null = null;

  constructor(
    readonly vehicle: PlannedVehicle,
    seed: number,
    private readonly intervalSeconds: number,
  ) {
    this.rng = createRng(subSeed(seed, 100_000 + vehicle.index));
    const [cLon, cLat] = vehicle.city.center;
    this.lon = cLon + (this.rng.next() - 0.5) * CITY_HALF_BOX_DEG;
    this.lat = cLat + (this.rng.next() - 0.5) * CITY_HALF_BOX_DEG;
    this.headingRad = this.rng.next() * 2 * Math.PI;
  }

  next(recordedAt: Date): SyntheticPoint {
    const rng = this.rng;
    let stopped = this.stopTicksLeft > 0;
    if (stopped) {
      this.stopTicksLeft -= 1;
    } else if (rng.next() < 0.01) {
      this.stopTicksLeft = 10 + Math.floor(rng.next() * 60);
      stopped = true;
    }
    if (stopped) {
      this.speed = 0;
      this.stoppedSince ??= recordedAt;
    } else {
      this.stoppedSince = null;
      this.speed = clamp((this.speed || 8) + (rng.next() - 0.5) * 4, 3, 22);
      this.headingRad += (rng.next() - 0.5) * 0.4;
      const meters = this.speed * this.intervalSeconds;
      const nextLat = this.lat + (meters * Math.cos(this.headingRad)) / METERS_PER_DEG_LAT;
      const nextLon = this.lon + (meters * Math.sin(this.headingRad)) / (METERS_PER_DEG_LAT * Math.cos((this.lat * Math.PI) / 180));
      const [cLon, cLat] = this.vehicle.city.center;
      if (Math.abs(nextLon - cLon) > CITY_HALF_BOX_DEG || Math.abs(nextLat - cLat) > CITY_HALF_BOX_DEG) {
        // Fuera de la caja: de vuelta hacia el centro, sin moverse este tick.
        this.headingRad = Math.atan2(cLon - this.lon, cLat - this.lat);
      } else {
        this.lon = nextLon;
        this.lat = nextLat;
      }
    }

    const lowAccuracy = rng.next() < 0.02;
    const point: SyntheticPoint = {
      eventId: uuidFrom(rng),
      tenantId: this.vehicle.tenantId,
      vehicleId: this.vehicle.id,
      deviceId: this.vehicle.deviceId,
      recordedAt,
      receivedAt: new Date(recordedAt.getTime() + 1000 + Math.floor(rng.next() * 4000)),
      lon: round6(this.lon),
      lat: round6(this.lat),
      speedMps: rng.next() < 0.005 ? null : round6(this.speed),
      headingDeg: round6((((this.headingRad * 180) / Math.PI) % 360 + 360) % 360),
      accuracyM: round6(lowAccuracy ? 60 + rng.next() * 100 : 3 + rng.next() * 12),
      altitudeM: round6(this.vehicle.city.altitudeM + (rng.next() - 0.5) * 40),
      mocked: rng.next() < 0.005,
      lowAccuracy,
    };
    this.last = point;
    return point;
  }

  finalState(): FinalVehicleState | null {
    if (this.last === null) return null;
    return { vehicle: this.vehicle, point: this.last, movement: this.stoppedSince === null ? "moving" : "stopped", stoppedSince: this.stoppedSince };
  }
}

export function ticksPerDay(intervalSeconds: number): number {
  return Math.floor(86_400 / intervalSeconds);
}

export function datasetStart(config: Pick<GeneratorConfig, "days" | "endAt">): Date {
  return new Date(config.endAt.getTime() - config.days * 86_400_000);
}

export function totalRows(config: Pick<GeneratorConfig, "vehicles" | "days" | "intervalSeconds">): number {
  return config.vehicles * config.days * ticksPerDay(config.intervalSeconds);
}

/**
 * Puntos de un vehículo en un día (0 = el primero), en orden cronológico. El simulador conserva el estado entre días, así que hay que
 * pedir los días en orden.
 */
export function* vehicleDay(simulator: VehicleSimulator, config: GeneratorConfig, day: number): Generator<SyntheticPoint> {
  const start = datasetStart(config).getTime() + day * 86_400_000 + simulator.vehicle.offsetSeconds * 1000;
  const ticks = ticksPerDay(config.intervalSeconds);
  for (let tick = 0; tick < ticks; tick += 1) {
    yield simulator.next(new Date(start + tick * config.intervalSeconds * 1000));
  }
}

export type ZoneKind = "critical" | "depot" | "customer";

export interface PlannedZone {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly kind: ZoneKind;
  /** Anillo cerrado de [lon, lat] (primer y último vértice iguales). */
  readonly ring: readonly LonLat[];
}

/** Cuadrado alrededor de un centro, en [lon, lat], anillo cerrado y en sentido antihorario. */
export function squareRing(center: LonLat, halfDeg: number): readonly LonLat[] {
  const [lon, lat] = center;
  return [
    [round6(lon - halfDeg), round6(lat - halfDeg)],
    [round6(lon + halfDeg), round6(lat - halfDeg)],
    [round6(lon + halfDeg), round6(lat + halfDeg)],
    [round6(lon - halfDeg), round6(lat + halfDeg)],
    [round6(lon - halfDeg), round6(lat - halfDeg)],
  ];
}

/** WKT con LONGITUD primero (`POLYGON((lon lat, ...))`), para `ST_GeomFromText(wkt, 4326)`. */
export function ringToWkt(ring: readonly LonLat[]): string {
  return `POLYGON((${ring.map(([lon, lat]) => `${lon} ${lat}`).join(", ")}))`;
}

/**
 * Zonas por tenant. Hasta una cuarta parte son críticas centradas en donde terminó un vehículo detenido (para que la consulta
 * espacial devuelva filas); el resto, repartidas al azar por las ciudades del tenant, con un 20 % críticas.
 */
export function planZones(
  config: Pick<GeneratorConfig, "seed">,
  tenants: readonly PlannedTenant[],
  finals: readonly FinalVehicleState[],
  zonesPerTenant: number,
): readonly PlannedZone[] {
  const zones: PlannedZone[] = [];
  for (const tenant of tenants) {
    const rng = createRng(subSeed(config.seed, 500_000 + tenant.index));
    const cities = TENANT_CITIES[tenant.index] ?? [];
    const anchors = finals.filter((f) => f.vehicle.tenantId === tenant.id && f.movement === "stopped").slice(0, Math.floor(zonesPerTenant / 4));
    for (let i = 0; i < zonesPerTenant; i += 1) {
      const anchor = anchors[i];
      const city = cities[Math.floor(rng.next() * cities.length)] ?? BOGOTA;
      const center: LonLat =
        anchor !== undefined
          ? [anchor.point.lon, anchor.point.lat]
          : [city.center[0] + (rng.next() - 0.5) * 2 * CITY_HALF_BOX_DEG, city.center[1] + (rng.next() - 0.5) * 2 * CITY_HALF_BOX_DEG];
      const kindRoll = rng.next();
      const kind: ZoneKind = anchor !== undefined || kindRoll < 0.2 ? "critical" : kindRoll < 0.6 ? "depot" : "customer";
      zones.push({
        id: uuidFrom(rng),
        tenantId: tenant.id,
        name: `zona-${String(i).padStart(5, "0")}`,
        kind,
        ring: squareRing(center, 0.0015 + rng.next() * 0.0045),
      });
    }
  }
  return zones;
}
