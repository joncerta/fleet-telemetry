// Prepara el tenant de carga: tenant, vehículos y un dispositivo (token) por vehículo. SOLO LOCAL.
//
//   node --env-file-if-exists=.env infra/k6/scripts/setup.mjs [--vehicles 300]
//
// - Guardas: host local (allowlist de @fleet/platform) y marca de servidor `fleet.environment = 'local'`.
// - Conecta como `fleet_app` (DATABASE_URL): alcanza para INSERT/UPDATE de tenants, vehículos y dispositivos.
// - Idempotente: tenant y vehículos con ON CONFLICT DO NOTHING; los dispositivos activos del tenant se REVOCAN y se emiten
//   nuevos (los tokens en claro no se pueden recuperar). Todo en una transacción.
// - En la base solo queda el sha256 de cada token (`sha256Hex`, el mismo que usa el gateway). Los tokens en claro van solo a
//   infra/k6/.run/tokens.json (ignorado por git, permisos 0600) y nunca a stdout ni a logs.
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  contracts,
  createScriptLogger,
  ensureRunDir,
  LOAD_TENANT_ID,
  LOAD_TENANT_NAME,
  loadPlate,
  loadVehicleId,
  MAX_LOAD_VEHICLES,
  platform,
  requireEnv,
  TOKENS_FILE,
} from "./common.mjs";

const DEFAULT_VEHICLES = 300;

function parseVehicles(argv) {
  const index = argv.indexOf("--vehicles");
  if (index === -1) return DEFAULT_VEHICLES;
  const value = Number(argv[index + 1]);
  if (!Number.isInteger(value) || value < 1 || value > MAX_LOAD_VEHICLES) {
    throw new Error(`--vehicles debe ser un entero de 1 a ${MAX_LOAD_VEHICLES}.`);
  }
  return value;
}

const logger = createScriptLogger("k6-setup");
let pool;
try {
  const vehicleCount = parseVehicles(process.argv.slice(2));
  const url = requireEnv("DATABASE_URL");
  // 1) Host local, sin conectar. 2) Marca del servidor, ya conectado.
  platform.assertLocalDatabaseHost(url);
  pool = platform.createPool({ connectionString: url, applicationName: "k6-setup", logger, max: 2 });
  const mark = await pool.query("SELECT current_setting($1, true) AS value", [platform.ENVIRONMENT_SETTING]);
  platform.assertLocalEnvironmentMark(mark.rows[0]?.value);

  const numbers = Array.from({ length: vehicleCount }, (_, index) => index + 1);
  const vehicleIds = numbers.map(loadVehicleId);
  const tokens = numbers.map(() => contracts.deviceTokenSchema.parse(`${contracts.DEVICE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`));

  const client = await pool.connect();
  let revoked = 0;
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO tenants (id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING", [LOAD_TENANT_ID, LOAD_TENANT_NAME]);
    await client.query(
      "INSERT INTO vehicles (id, tenant_id, plate, label) SELECT id, $1, plate, label FROM unnest($2::uuid[], $3::text[], $4::text[]) AS t(id, plate, label) ON CONFLICT DO NOTHING",
      [LOAD_TENANT_ID, vehicleIds, numbers.map(loadPlate), numbers.map((n) => `Carga ${String(n).padStart(3, "0")}`)],
    );
    // Un solo dispositivo activo por vehículo (índice único parcial de la migración 004): se revocan los del tenant y se crean nuevos.
    const revocation = await client.query("UPDATE devices SET revoked_at = now() WHERE tenant_id = $1 AND revoked_at IS NULL", [LOAD_TENANT_ID]);
    revoked = revocation.rowCount ?? 0;
    await client.query(
      "INSERT INTO devices (id, tenant_id, vehicle_id, token_hash) SELECT id, $1, vehicle_id, token_hash FROM unnest($2::uuid[], $3::uuid[], $4::text[]) AS t(id, vehicle_id, token_hash)",
      [LOAD_TENANT_ID, tokens.map(() => randomUUID()), vehicleIds, tokens.map((token) => platform.sha256Hex(token))],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  ensureRunDir();
  writeFileSync(
    TOKENS_FILE,
    JSON.stringify({ tenantId: LOAD_TENANT_ID, vehicles: numbers.map((_, i) => ({ vehicleId: vehicleIds[i], token: tokens[i] })) }),
    { mode: 0o600 },
  );
  logger.info({ tenantId: LOAD_TENANT_ID, vehicles: vehicleCount, devicesRevoked: revoked }, "Tenant de carga listo; tokens en infra/k6/.run/tokens.json");
} catch (error) {
  process.stderr.write(`k6 setup falló: ${error instanceof Error ? error.message : "error desconocido"}\n`);
  process.exitCode = 1;
} finally {
  await pool?.end();
}
