import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TOPICS } from "@fleet/contracts";
import { createAdmin, createKafka, createLogger } from "@fleet/platform";
import { AGENT_URL, E2E_AGENT_PORT, E2E_FLEET_API_PORT, E2E_GATEWAY_PORT, E2E_HOST, FLEET_API_URL, GATEWAY_URL, WEB_URL, type E2eEnv } from "./env";

/**
 * Servicios del e2e de la web: ingest-gateway, processor, fleet-api y el agente DESDE `dist/` (como el arnés de tests/e2e del backend),
 * con puertos, consumer group y secreto de sesión propios, para no chocar con un `pnpm dev` ni con el e2e del backend. La
 * infraestructura (TimescaleDB y Redpanda) es la del `docker compose` local. El agente usa el modelo con guion
 * (`AGENT_MODEL_PROVIDER=scripted`): determinista, sin red ni API key, por el mismo camino que Claude (herramientas, breaker, fleet-api).
 */

/** Fallos hacia fleet-api con los que el breaker del agente se abre en el e2e, y tiempo que se queda abierto antes de probar de nuevo. */
export const E2E_AGENT_BREAKER_VOLUME_THRESHOLD = 3;
const E2E_AGENT_BREAKER_RESET_TIMEOUT_MS = 30_000;
/**
 * Ventana en la que el breaker del agente cuenta los fallos. Con la de por defecto (10 s) el e2e del chat no abre el circuito: pregunta cada
 * ~6 s (la pregunta y hasta 5 s de espera del texto), así que nunca hay 3 fallos dentro de la ventana. Con 60 s los 3 fallos del test lo abren.
 */
const E2E_AGENT_BREAKER_ROLLING_WINDOW_MS = 60_000;

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const LOGS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", ".logs");
const READY_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 12_000;

type ServiceName = "ingest-gateway" | "processor" | "fleet-api" | "agent";
const SERVICE_DIRS: Record<ServiceName, string> = {
  "ingest-gateway": "services/ingest-gateway",
  processor: "services/processor",
  "fleet-api": "services/fleet-api",
  agent: "services/agent",
};

const entryOf = (name: ServiceName) => join(REPO_ROOT, SERVICE_DIRS[name], "dist", "main.js");

export interface E2eStack {
  gatewayUrl: string;
  fleetApiUrl: string;
  agentUrl: string;
  logDir: string;
  /** Mata fleet-api y lo vuelve a levantar con la misma configuración (la sesión sigue valiendo: mismo secreto). */
  restartFleetApi(): Promise<void>;
  /** Mata fleet-api (para ver el breaker del agente abierto). Idempotente. */
  stopFleetApi(): Promise<void>;
  /** Levanta fleet-api si está detenido y espera su `/health`. */
  startFleetApi(): Promise<void>;
  stop(): Promise<void>;
}

interface Child {
  name: ServiceName;
  process: ChildProcess;
  logFile: string;
  exited: boolean;
}

function tailOf(file: string, lines = 30): string {
  try {
    return readFileSync(file, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return "(sin log)";
  }
}

function spawnService(name: ServiceName, env: NodeJS.ProcessEnv, logDir: string): Child {
  const logFile = join(logDir, `${name}.log`);
  const fd = openSync(logFile, "a");
  try {
    const child = spawn(process.execPath, [entryOf(name)], { cwd: join(REPO_ROOT, SERVICE_DIRS[name]), env, stdio: ["ignore", fd, fd], windowsHide: true });
    const running: Child = { name, process: child, logFile, exited: false };
    child.once("exit", () => {
      running.exited = true;
    });
    child.once("error", () => {
      running.exited = true;
    });
    return running;
  } finally {
    closeSync(fd);
  }
}

async function stopChild(child: Child): Promise<void> {
  if (child.exited) return;
  const exited = new Promise<void>((resolve) => child.process.once("exit", () => resolve()));
  // En Windows `kill` termina el proceso sin aviso: sus sockets (el stream SSE incluido) se cortan, como en una caída real.
  child.process.kill("SIGTERM");
  let timer: NodeJS.Timeout | undefined;
  const forced = await Promise.race([exited.then(() => false), new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(true), STOP_TIMEOUT_MS)))]);
  clearTimeout(timer);
  if (forced) {
    child.process.kill("SIGKILL");
    await exited;
  }
}

async function waitFor(what: string, children: readonly Child[], probe: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    const dead = children.find((child) => child.exited);
    if (dead !== undefined) throw new Error(`${dead.name} terminó antes de estar listo (${what}). Log:\n${tailOf(dead.logFile)}`);
    if (await probe().catch(() => false)) return;
    if (Date.now() > deadline) {
      throw new Error(`Se agotó la espera: ${what}.\n${children.map((child) => `--- ${child.name}\n${tailOf(child.logFile)}`).join("\n")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const healthy = (url: string) => async () => (await fetch(`${url}/health`, { signal: AbortSignal.timeout(2_000) })).status === 200;

export function assertServicesBuilt(): void {
  const missing = (Object.keys(SERVICE_DIRS) as ServiceName[]).filter((name) => !existsSync(entryOf(name)));
  if (missing.length > 0) throw new Error(`Falta el build de ${missing.join(", ")}: corre \`pnpm build\` en la raíz antes del e2e.`);
}

export async function startStack(env: E2eEnv): Promise<E2eStack> {
  assertServicesBuilt();
  const runId = randomUUID().replaceAll("-", "").slice(0, 8);
  const logDir = join(LOGS_ROOT, `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${runId}`);
  mkdirSync(logDir, { recursive: true });
  const processorGroup = `processor-web-e2e-${runId}`;

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    LOG_LEVEL: process.env.LOG_LEVEL ?? "info",
    INGEST_GATEWAY_HOST: E2E_HOST,
    INGEST_GATEWAY_PORT: String(E2E_GATEWAY_PORT),
    PROCESSOR_CONSUMER_GROUP: processorGroup,
    FLEET_API_HOST: E2E_HOST,
    FLEET_API_PORT: String(E2E_FLEET_API_PORT),
    // Secreto PROPIO de cada corrida (nunca el del `.env`): una cookie del e2e no vale en otro entorno.
    SESSION_SECRET: `web-e2e-only-session-secret-${runId}-0123456789abcdef`,
    FLEET_API_CORS_ORIGINS: WEB_URL,
    FLEET_API_COOKIE_SECURE: "false",
    AGENT_HOST: E2E_HOST,
    AGENT_PORT: String(E2E_AGENT_PORT),
    FLEET_API_URL,
    AGENT_CORS_ORIGINS: WEB_URL,
    AGENT_MODEL_PROVIDER: "scripted",
    // Hermético: aunque el `.env` tenga una clave real, el e2e no la usa ni se la pasa al hijo.
    ANTHROPIC_API_KEY: "",
    AGENT_USER_RATE_LIMIT_MAX: "200",
    AGENT_FLEET_API_TIMEOUT_MS: "2000",
    AGENT_BREAKER_VOLUME_THRESHOLD: String(E2E_AGENT_BREAKER_VOLUME_THRESHOLD),
    AGENT_BREAKER_RESET_TIMEOUT_MS: String(E2E_AGENT_BREAKER_RESET_TIMEOUT_MS),
    AGENT_BREAKER_ROLLING_WINDOW_MS: String(E2E_AGENT_BREAKER_ROLLING_WINDOW_MS),
  };

  // El grupo del processor se ancla al final de `telemetry.raw` ANTES de arrancarlo: solo procesa lo que el e2e envíe.
  const kafka = createKafka({ brokers: env.KAFKA_BROKERS, clientId: `web-e2e-${runId}`, logger: createLogger({ service: "web-e2e", level: "error" }) });
  const admin = createAdmin(kafka);
  await admin.connect();
  try {
    const ends = await admin.fetchTopicOffsets(TOPICS.telemetryRaw);
    await admin.setOffsets({ groupId: processorGroup, topic: TOPICS.telemetryRaw, partitions: ends.map(({ partition, high }) => ({ partition, offset: high })) });
  } catch (error) {
    await admin.disconnect().catch(() => undefined);
    throw error;
  }

  const children: Record<ServiceName, Child> = {
    "ingest-gateway": spawnService("ingest-gateway", childEnv, logDir),
    processor: spawnService("processor", childEnv, logDir),
    "fleet-api": spawnService("fleet-api", childEnv, logDir),
    agent: spawnService("agent", childEnv, logDir),
  };
  const all = () => Object.values(children);

  const startFleetApi = async (what: string) => {
    if (!children["fleet-api"].exited) return;
    children["fleet-api"] = spawnService("fleet-api", childEnv, logDir);
    await waitFor(what, all(), healthy(FLEET_API_URL));
  };

  const stop = async () => {
    await Promise.all(all().map((child) => stopChild(child).catch(() => undefined)));
    await admin.deleteGroups([processorGroup]).catch(() => undefined);
    await admin.disconnect().catch(() => undefined);
  };

  try {
    await waitFor("GET /health del gateway", all(), healthy(GATEWAY_URL));
    await waitFor("GET /health de fleet-api", all(), healthy(FLEET_API_URL));
    await waitFor("GET /health del agente", all(), healthy(AGENT_URL));
    await waitFor(`processor consumiendo (${processorGroup})`, all(), async () => {
      const { groups } = await admin.describeGroups([processorGroup]);
      const group = groups.find((candidate) => candidate.groupId === processorGroup);
      return group?.state === "Stable" && group.members.length > 0;
    });
  } catch (error) {
    await stop();
    throw error;
  }

  return {
    gatewayUrl: GATEWAY_URL,
    fleetApiUrl: FLEET_API_URL,
    agentUrl: AGENT_URL,
    logDir,
    async restartFleetApi() {
      await stopChild(children["fleet-api"]);
      await startFleetApi("GET /health de fleet-api tras el reinicio");
    },
    async stopFleetApi() {
      await stopChild(children["fleet-api"]);
    },
    async startFleetApi() {
      await startFleetApi("GET /health de fleet-api al volver a levantarlo");
    },
    stop,
  };
}
