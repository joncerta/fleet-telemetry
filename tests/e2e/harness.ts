import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TOPICS } from "@fleet/contracts";
import { createAdmin, createKafka, createLogger } from "@fleet/platform";
import { AssignerProtocol, type Admin } from "kafkajs";

// Arnés e2e: levanta ingest-gateway, processor y fleet-api DESDE dist/ como procesos hijos, con puertos y consumer group propios
// del e2e para no chocar con un `pnpm dev` de nadie. Los cierra siempre al terminar, también si un test falla.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LOGS_ROOT = join(dirname(fileURLToPath(import.meta.url)), ".logs");
const KEEP_LOG_RUNS = 10;

/** Puerto del gateway del e2e: distinto del 4001 del `pnpm dev`. */
export const E2E_GATEWAY_PORT = 14001;
/** Puerto de fleet-api del e2e: distinto del 4002 del `pnpm dev`. */
export const E2E_FLEET_API_PORT = 14002;
/** Fallos de login por IP y por correo, y de canje de código por IP, que tolera fleet-api en el e2e; los tests los usan para agotarlos. */
export const E2E_LOGIN_FAILURE_LIMIT_MAX = 5;
export const E2E_PAIR_FAILURE_LIMIT_MAX = 5;
/** Fallos de autenticación (401) por IP y minuto que tolera el gateway del e2e; los tests lo usan para agotarlo. */
export const E2E_AUTH_FAILURE_LIMIT_MAX = 20;
const READY_TIMEOUT_MS = 45_000;
const POLL_INTERVAL_MS = 250;
const STOP_TIMEOUT_MS = 12_000;

export interface ServiceDefinition {
  name: "ingest-gateway" | "processor" | "fleet-api";
  /** Carpeta del servicio, relativa a la raíz del repo. */
  dir: string;
}

export const SERVICES: readonly ServiceDefinition[] = [
  { name: "ingest-gateway", dir: "services/ingest-gateway" },
  { name: "processor", dir: "services/processor" },
  { name: "fleet-api", dir: "services/fleet-api" },
];

export interface RunningServices {
  runId: string;
  /** Fin de cada partición de `telemetry.raw` (offset siguiente al último) cuando se ancló el grupo: el processor del e2e no lee nada anterior. */
  rawBacklogEnd: Record<string, string>;
  gatewayUrl: string;
  fleetApiUrl: string;
  processorGroup: string;
  /** Carpeta con un archivo de log por servicio, de esta corrida. */
  logDir: string;
  /** Cierra los procesos hijos (y borra el consumer group del e2e). Idempotente; no lanza. */
  stop(): Promise<void>;
}

const E2E_GROUP_PREFIX = "processor-e2e-";

const entryOf = (service: ServiceDefinition) => join(REPO_ROOT, service.dir, "dist", "main.js");

/**
 * Borra los grupos `processor-e2e-*` que dejaron corridas anteriores. Solo prospera con los que están vacíos: en
 * Windows el teardown termina al processor sin que salga del grupo, y esos grupos quedan "Empty" hasta la siguiente
 * corrida. Uno con miembros vivos (otra corrida en curso) lo rechaza el broker, y se ignora.
 */
export async function deleteStaleE2eGroups(admin: Pick<Admin, "listGroups" | "deleteGroups">, keep: string): Promise<void> {
  const { groups } = await admin.listGroups();
  const stale = groups.map((group) => group.groupId).filter((groupId) => groupId.startsWith(E2E_GROUP_PREFIX) && groupId !== keep);
  for (const groupId of stale) await admin.deleteGroups([groupId]).catch(() => undefined);
}

/**
 * Fija los offsets del grupo al final de cada partición de `topic`, ANTES de que arranque su consumer. Un grupo nuevo con
 * `fromBeginning: true` leería todo el tópico (días de corridas anteriores): masticaría el backlog, republicaría en la DLQ los
 * rechazos viejos y reinsertaría telemetría de tenants e2e ya borrados. Con los offsets fijados solo lee lo que se produzca
 * después. `setOffsets` exige que el grupo no tenga miembros, y el del e2e es nuevo. Devuelve el offset fijado por partición.
 */
export async function pinGroupToTopicEnd(
  admin: Pick<Admin, "fetchTopicOffsets" | "setOffsets">,
  groupId: string,
  topic: string,
): Promise<Record<string, string>> {
  const ends = await admin.fetchTopicOffsets(topic);
  await admin.setOffsets({ groupId, topic, partitions: ends.map(({ partition, high }) => ({ partition, offset: high })) });
  return Object.fromEntries(ends.map(({ partition, high }) => [String(partition), high]));
}

/** Exige que el build exista: los hijos corren `dist/main.js`, no el código fuente. */
export function assertBuilt(): void {
  const missing = SERVICES.filter((service) => !existsSync(entryOf(service)));
  if (missing.length > 0) {
    throw new Error(
      `Falta el build de: ${missing.map((s) => s.name).join(", ")}. El e2e levanta los servicios desde dist/: corre \`pnpm build\` ` +
        "(o `pnpm test:e2e`, que lo hace antes por la dependencia de turbo) y vuelve a intentarlo.",
    );
  }
}

/** Entorno de los hijos: el del proceso (ya trae el `.env` de la raíz) más lo propio del e2e, que siempre gana. */
export function childEnv(runId: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    INGEST_GATEWAY_HOST: "127.0.0.1",
    INGEST_GATEWAY_PORT: String(E2E_GATEWAY_PORT),
    // Con 1 salto de proxy de confianza, un test elige su IP de cliente con `X-Forwarded-For` (la conexión es siempre 127.0.0.1):
    // así puede agotar el límite de 401 de SU IP sin afectar a los demás tests, que no mandan el header.
    INGEST_GATEWAY_TRUSTED_PROXY_HOPS: "1",
    INGEST_GATEWAY_AUTH_FAILURE_LIMIT_MAX: String(E2E_AUTH_FAILURE_LIMIT_MAX),
    PROCESSOR_CONSUMER_GROUP: `${E2E_GROUP_PREFIX}${runId}`,
    FLEET_API_HOST: "127.0.0.1",
    FLEET_API_PORT: String(E2E_FLEET_API_PORT),
    // Secreto PROPIO del e2e (nunca el del `.env`): por corrida, de más de 32 bytes. Las cookies de una corrida no valen en otra.
    SESSION_SECRET: `e2e-only-session-secret-${runId}-0123456789abcdef`,
    // Igual que el gateway: con 1 salto de proxy un test elige su IP con `X-Forwarded-For` y agota SU límite sin afectar a los demás.
    FLEET_API_TRUSTED_PROXY_HOPS: "1",
    FLEET_API_LOGIN_FAILURE_LIMIT_MAX: String(E2E_LOGIN_FAILURE_LIMIT_MAX),
    FLEET_API_PAIR_FAILURE_LIMIT_MAX: String(E2E_PAIR_FAILURE_LIMIT_MAX),
    FLEET_API_CORS_ORIGINS: "http://localhost:3000",
    FLEET_API_COOKIE_SECURE: "false",
  };
}

function pruneOldLogRuns(): void {
  if (!existsSync(LOGS_ROOT)) return;
  const runs = readdirSync(LOGS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const old of runs.slice(0, Math.max(0, runs.length - KEEP_LOG_RUNS))) rmSync(join(LOGS_ROOT, old), { recursive: true, force: true });
}

function tailOf(file: string, lines = 25): string {
  try {
    return readFileSync(file, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return "(sin log)";
  }
}

interface Child {
  service: ServiceDefinition;
  process: ChildProcess;
  logFile: string;
  exited: boolean;
}

function spawnService(service: ServiceDefinition, env: NodeJS.ProcessEnv, logDir: string): Child {
  const logFile = join(logDir, `${service.name}.log`);
  const fd = openSync(logFile, "a");
  try {
    const child = spawn(process.execPath, [entryOf(service)], {
      cwd: join(REPO_ROOT, service.dir),
      env,
      stdio: ["ignore", fd, fd],
      windowsHide: true,
    });
    const running: Child = { service, process: child, logFile, exited: false };
    const markExited = () => {
      running.exited = true;
    };
    child.once("exit", markExited);
    child.once("error", markExited);
    return running;
  } finally {
    // El hijo ya heredó el descriptor: el padre no lo necesita.
    closeSync(fd);
  }
}

async function waitFor(what: string, children: readonly Child[], probe: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    const dead = children.find((child) => child.exited);
    if (dead) {
      throw new Error(`${dead.service.name} terminó antes de estar listo (esperando: ${what}). Últimas líneas de su log:\n${tailOf(dead.logFile)}`);
    }
    if (await probe().catch(() => false)) return;
    if (Date.now() > deadline) {
      const logs = children.map((child) => `--- ${child.service.name} (${child.logFile})\n${tailOf(child.logFile)}`).join("\n");
      throw new Error(`Se agotaron ${READY_TIMEOUT_MS} ms esperando: ${what}.\n${logs}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/** ¿El grupo está estable y tiene asignadas particiones de `telemetry.raw`? Es lo que significa "el processor consume". */
export async function processorIsConsuming(admin: Pick<Admin, "describeGroups">, groupId: string): Promise<boolean> {
  const { groups } = await admin.describeGroups([groupId]);
  const group = groups.find((candidate) => candidate.groupId === groupId);
  if (group?.state !== "Stable") return false;
  return group.members.some((member) => {
    const decoded = AssignerProtocol.MemberAssignment.decode(member.memberAssignment);
    return (decoded?.assignment[TOPICS.telemetryRaw]?.length ?? 0) > 0;
  });
}

async function stopChild(child: Child): Promise<void> {
  if (child.exited) return;
  const exited = new Promise<void>((resolve) => child.process.once("exit", () => resolve()));
  // SIGTERM inicia el apagado ordenado en Linux y macOS. En Windows `kill` termina el proceso sin dar aviso.
  child.process.kill("SIGTERM");

  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), STOP_TIMEOUT_MS);
  });
  const forced = await Promise.race([exited.then(() => false), timedOut]);
  // Sin esto el temporizador retiene el proceso de vitest hasta que se cumple.
  clearTimeout(timer);
  if (forced) {
    child.process.kill("SIGKILL");
    await exited;
  }
}

/**
 * Levanta los servicios y espera a que estén listos (`/health` del gateway en 200 y el processor con particiones
 * asignadas). Si algo falla en el arranque, cierra lo que ya había levantado y lanza el error con las últimas líneas
 * del log de cada servicio.
 */
export async function startServices(options: { kafkaBrokers: readonly string[] }): Promise<RunningServices> {
  assertBuilt();

  const runId = randomUUID().replaceAll("-", "").slice(0, 8);
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const logDir = join(LOGS_ROOT, `${stamp}-${runId}`);
  mkdirSync(logDir, { recursive: true });
  pruneOldLogRuns();

  const env = childEnv(runId);
  const processorGroup = `${E2E_GROUP_PREFIX}${runId}`;
  const gatewayUrl = `http://127.0.0.1:${E2E_GATEWAY_PORT}`;
  const fleetApiUrl = `http://127.0.0.1:${E2E_FLEET_API_PORT}`;

  const kafka = createKafka({ brokers: options.kafkaBrokers, clientId: `e2e-harness-${runId}`, logger: createLogger({ service: "e2e-harness", level: "error" }) });
  const admin = createAdmin(kafka);
  // Los grupos se anclan ANTES de lanzar el processor: con el consumer ya corriendo sería tarde.
  let rawBacklogEnd: Record<string, string>;
  try {
    await admin.connect();
    rawBacklogEnd = await pinGroupToTopicEnd(admin, processorGroup, TOPICS.telemetryRaw);
  } catch (error) {
    await admin.disconnect().catch(() => undefined);
    throw error;
  }
  const children = SERVICES.map((service) => spawnService(service, env, logDir));

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    process.off("exit", killSync);
    await Promise.all(children.map((child) => stopChild(child).catch(() => undefined)));
    // Limpieza del grupo del e2e: falla si el proceso no llegó a salir limpio (Windows); no importa, es de un solo uso.
    await admin.deleteGroups([processorGroup]).catch(() => undefined);
    await admin.disconnect().catch(() => undefined);
  };
  // Último recurso si el proceso padre muere sin pasar por el teardown de vitest.
  function killSync(): void {
    for (const child of children) if (!child.exited) child.process.kill("SIGKILL");
  }
  process.once("exit", killSync);

  try {
    await deleteStaleE2eGroups(admin, processorGroup).catch(() => undefined);
    await waitFor(
      "GET /health del gateway con 200",
      children,
      async () => (await fetch(`${gatewayUrl}/health`, { signal: AbortSignal.timeout(2_000) })).status === 200,
    );
    await waitFor(
      "GET /health de fleet-api con 200",
      children,
      async () => (await fetch(`${fleetApiUrl}/health`, { signal: AbortSignal.timeout(2_000) })).status === 200,
    );
    await waitFor(`que el processor consuma (grupo ${processorGroup})`, children, () => processorIsConsuming(admin, processorGroup));
  } catch (error) {
    await stop();
    throw error;
  }

  return { runId, rawBacklogEnd, gatewayUrl, fleetApiUrl, processorGroup, logDir, stop };
}
