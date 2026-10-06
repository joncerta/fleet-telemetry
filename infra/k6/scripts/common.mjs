// Utilidades compartidas de los scripts de carga. Reutilizan @fleet/platform y @fleet/contracts YA COMPILADOS (`pnpm build`),
// para no duplicar el formato del token, el hash ni las guardas de "solo local". Sin dependencias nuevas.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const K6_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = path.resolve(K6_DIR, "..", "..");
/** Carpeta de trabajo de las corridas (ignorada por git): tokens, resúmenes y resultados. Nunca se commitea. */
export const RUN_DIR = path.join(K6_DIR, ".run");
export const TOKENS_FILE = path.join(RUN_DIR, "tokens.json");

export const platform = await import(new URL("../../../packages/platform/dist/index.js", import.meta.url));
export const contracts = await import(new URL("../../../packages/contracts/dist/index.js", import.meta.url));

/** Tenant de carga: UUID fijo (v4, variante RFC 4122) y nombre propio. Los datos de demo usan f1ee7000-...-00000000000{1,2}. */
export const LOAD_TENANT_ID = "f1ee7000-0000-4000-8000-0000000000f0";
export const LOAD_TENANT_NAME = "Carga k6 (solo local)";
export const MAX_LOAD_VEHICLES = 999;

/** `f1ee7000-0000-4000-9000-<12 dígitos>`: vehículos de carga, distintos de los de demo (que usan 1xxx y 2xxx). */
export const loadVehicleId = (number) => `f1ee7000-0000-4000-9000-${String(900_000 + number).padStart(12, "0")}`;
export const loadPlate = (number) => `LDT${String(number).padStart(3, "0")}`;

export function requireEnv(name) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`Falta la variable ${name} (copia .env.example a .env y ejecuta desde la raíz con node --env-file-if-exists=.env).`);
  }
  return value;
}

export function ensureRunDir() {
  mkdirSync(RUN_DIR, { recursive: true });
}

export function createScriptLogger(service) {
  // Logs a stderr: stdout queda libre para el resultado. El logger de la plataforma redacta datos personales.
  return platform.createLogger({ service, level: process.env.LOG_LEVEL ?? "info", destination: process.stderr });
}

/** Lista de brokers de `KAFKA_BROKERS` (host:puerto separados por coma). */
export function kafkaBrokers() {
  return requireEnv("KAFKA_BROKERS")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

/** Cliente de Kafka con los logs de kafkajs en nivel `error` (los de info del consumer group son ruido en un script). */
export function createKafkaClient(clientId) {
  const quiet = platform.createLogger({ service: clientId, level: "error", destination: process.stderr });
  return platform.createKafka({ brokers: kafkaBrokers(), clientId, logger: quiet });
}

export const sleep =(ms) => new Promise((resolve) => setTimeout(resolve, ms));
