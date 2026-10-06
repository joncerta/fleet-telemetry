import { randomUUID } from "node:crypto";
import { batchAckSchema, type TelemetryPoint } from "@fleet/contracts";
import { assertLocalDatabase, issueDeviceToken, seedVehicles, type SeedVehicle } from "@fleet/dev-data";
import pg from "pg";
import type { E2eEnv } from "./env";

/**
 * Emite telemetría real por el gateway para vehículos SEMBRADOS (los de `operador@norte.test` y `operador@sur.test`). Los tokens se
 * emiten con `issueDeviceToken` de `@fleet/dev-data` (el mismo que usa el simulador), tras las guardas de base local. Emitir ROTA el
 * dispositivo del vehículo: por eso el e2e usa pocos vehículos (los últimos de cada tenant) y no todos.
 */
export interface FleetDriver {
  vehicle(plate: string): SeedVehicle;
  /** Envía un punto del vehículo y espera el ACK `accepted`. Devuelve el `eventId`. */
  send(plate: string, point?: Partial<Omit<TelemetryPoint, "eventId" | "vehicleId">>): Promise<string>;
  close(): Promise<void>;
}

/** Centro aproximado de cada flota de demo (`[lng, lat]`), lejos de sus zonas críticas para no levantar alertas por detención. */
const BASE_POSITION: Record<string, [number, number]> = { NRT: [-74.06, 4.68], SUR: [-75.57, 6.25] };

export async function createFleetDriver(env: E2eEnv, gatewayUrl: string, plates: readonly string[]): Promise<FleetDriver> {
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 2 });
  await assertLocalDatabase({ url: env.DATABASE_URL, variable: "DATABASE_URL", command: "test:e2e (web)", db: pool });

  const vehicles = new Map(seedVehicles().map((vehicle) => [vehicle.plate, vehicle]));
  const tokens = new Map<string, string>();
  for (const plate of plates) {
    const vehicle = vehicles.get(plate);
    if (vehicle === undefined) throw new Error(`No hay un vehículo sembrado con la placa ${plate} (¿corriste pnpm db:seed?).`);
    tokens.set(plate, (await issueDeviceToken(pool, vehicle.id)).token);
  }

  const vehicleOf = (plate: string): SeedVehicle => {
    const vehicle = vehicles.get(plate);
    if (vehicle === undefined) throw new Error(`Placa desconocida: ${plate}`);
    return vehicle;
  };

  return {
    vehicle: vehicleOf,
    async send(plate, overrides = {}) {
      const vehicle = vehicleOf(plate);
      const token = tokens.get(plate);
      if (token === undefined) throw new Error(`Sin token para ${plate}: agrégala a las placas del driver.`);
      const [lon, lat] = BASE_POSITION[plate.slice(0, 3)] ?? [-74.06, 4.68];
      const now = new Date().toISOString();
      const point: TelemetryPoint = {
        eventId: randomUUID(),
        vehicleId: vehicle.id,
        recordedAt: now,
        lon: lon + Math.random() * 0.01,
        lat: lat + Math.random() * 0.01,
        speedMps: 10,
        headingDeg: 90,
        accuracyM: 5,
        mocked: false,
        lowAccuracy: false,
        ...overrides,
      };
      const response = await fetch(`${gatewayUrl}/v1/telemetry/batches`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ schemaVersion: 1, sentAt: now, points: [point] }),
      });
      const ack = batchAckSchema.parse(await response.json());
      if (!ack.accepted.includes(point.eventId)) throw new Error(`El gateway no aceptó el punto de ${plate}: ${JSON.stringify(ack.rejected)}`);
      return point.eventId;
    },
    async close() {
      await pool.end();
    },
  };
}
