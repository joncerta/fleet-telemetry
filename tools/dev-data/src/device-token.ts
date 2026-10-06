import { randomBytes, randomUUID } from "node:crypto";
import { DEVICE_TOKEN_PREFIX, deviceTokenSchema } from "@fleet/contracts";
import { sha256Hex } from "@fleet/platform";
import type { Pool } from "pg";

/** Token de dispositivo: `fdt_` + 32 bytes aleatorios en base64url (formato de `deviceTokenSchema`). */
export function generateDeviceToken(): string {
  return deviceTokenSchema.parse(`${DEVICE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`);
}

export class VehicleLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VehicleLookupError";
  }
}

export interface IssuedDeviceToken {
  /** El token en claro. Se muestra una sola vez y nunca se guarda ni se loguea. */
  token: string;
  deviceId: string;
  vehicleId: string;
  /** Dispositivos activos del vehículo que esta emisión revocó (0 si es el primero). */
  revokedDevices: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Crea un dispositivo para el vehículo (por id o por placa) o, si ya tiene uno activo, lo rota: revoca los activos
 * y crea el nuevo, en una transacción (nunca quedan dos activos ni ninguno a medias). Solo se guarda el sha256 del
 * token. Una placa se repite entre tenants: si hay más de un vehículo con esa placa, se pide el id.
 */
export async function issueDeviceToken(pool: Pick<Pool, "connect">, vehicle: string): Promise<IssuedDeviceToken> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = UUID.test(vehicle)
      ? await client.query<{ id: string; tenant_id: string }>("SELECT id, tenant_id FROM vehicles WHERE id = $1", [vehicle.toLowerCase()])
      : await client.query<{ id: string; tenant_id: string }>("SELECT id, tenant_id FROM vehicles WHERE plate = $1 LIMIT 2", [
          vehicle.trim().toUpperCase(),
        ]);
    const [found, other] = rows;
    if (found === undefined) throw new VehicleLookupError("No existe un vehículo con ese id o esa placa (¿corriste pnpm db:seed?).");
    if (other !== undefined) throw new VehicleLookupError("Hay varios vehículos con esa placa (en tenants distintos): usa el id del vehículo.");

    // Se revoca por (vehículo, tenant): el mismo par que exige la FK compuesta de devices.
    const revoked = await client.query(
      "UPDATE devices SET revoked_at = now() WHERE vehicle_id = $1 AND tenant_id = $2 AND revoked_at IS NULL",
      [found.id, found.tenant_id],
    );
    const token = generateDeviceToken();
    const deviceId = randomUUID();
    await client.query("INSERT INTO devices (id, tenant_id, vehicle_id, token_hash) VALUES ($1, $2, $3, $4)", [
      deviceId,
      found.tenant_id,
      found.id,
      sha256Hex(token),
    ]);
    await client.query("COMMIT");
    return { token, deviceId, vehicleId: found.id, revokedDevices: revoked.rowCount ?? 0 };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Lee `--vehicle <id|placa>`. Tolera el `--` que `pnpm device:token -- --vehicle X` deja como primer argumento. */
export function parseVehicleArg(argv: readonly string[]): string {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const value = args[0] === "--vehicle" ? args[1] : undefined;
  if (value === undefined || value === "" || value.startsWith("--") || args.length !== 2) {
    throw new VehicleLookupError("Uso: pnpm device:token -- --vehicle <id|placa>");
  }
  return value;
}
