import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentHealthResponseSchema, apiErrorSchema, chatResponseSchema, sessionSchema } from "@fleet/contracts";
import { hashPassword, loadConfig } from "@fleet/platform";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { startFakeAnthropic, type FakeAnthropic } from "./fake-anthropic.js";
import { childEnv } from "./harness.js";
import "./provided-context.js";
import { e2eConfigSchema } from "./support.js";

// Breaker del proveedor del modelo, de punta a punta: un agente PROPIO (para no tocar el del arnés, que usa el modelo con guion) con
// `AGENT_MODEL_PROVIDER=anthropic` apuntando a un Anthropic falso que el test controla. Recorre el ChatAnthropic real (`maxRetries`), el guard
// con su breaker y las herramientas que llegan en el cuerpo de la petición. fleet-api (con el que inicia sesión) sí es el del arnés.
const fleetApiUrl = inject("fleetApiUrl");
const runId = inject("runId");
const config = loadConfig(e2eConfigSchema);
const db = new Client({ connectionString: config.DATABASE_ADMIN_URL });

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const AGENT_PORT = 14043;
const agentUrl = `http://127.0.0.1:${AGENT_PORT}`;
const CHEAP_SCRYPT = { N: 1_024, r: 8, p: 1 } as const;
const QUESTION = "Dame un resumen de la flota";
const json = { "content-type": "application/json" };

let fake: FakeAnthropic;
let agent: ChildProcess | undefined;
let tenantId: string;
let email: string;
let password: string;
let ipCounter = 150;
const nextIp = () => `198.51.100.${ipCounter++}`;

beforeAll(async () => {
  fake = await startFakeAnthropic();
  await db.connect();
  tenantId = randomUUID();
  email = `e2e-model-${runId}@flota.test`;
  password = randomBytes(18).toString("base64url");
  await db.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [tenantId, `e2e-model-${runId}`]);
  await db.query("INSERT INTO users (user_id, tenant_id, email, name, password_hash) VALUES ($1, $2, $3, $4, $5)", [
    randomUUID(),
    tenantId,
    email,
    "Operador modelo",
    await hashPassword(password, { ...CHEAP_SCRYPT }),
  ]);

  agent = spawn(process.execPath, [join(REPO_ROOT, "services", "agent", "dist", "main.js")], {
    cwd: join(REPO_ROOT, "services", "agent"),
    env: {
      ...childEnv(runId),
      AGENT_PORT: String(AGENT_PORT),
      AGENT_MODEL_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "sk-ant-falsa-e2e",
      ANTHROPIC_WORKSPACE_ID: "wrkspc_e2eFake",
      ANTHROPIC_BASE_URL: fake.url,
      AGENT_MODEL: "claude-fake",
      AGENT_MODEL_TIMEOUT_MS: "5000",
      AGENT_BREAKER_VOLUME_THRESHOLD: "3",
      AGENT_BREAKER_RESET_TIMEOUT_MS: "2000",
    },
    stdio: "ignore",
    windowsHide: true,
  });
  await vi.waitFor(async () => expect((await fetch(`${agentUrl}/health`, { signal: AbortSignal.timeout(2_000) })).status).toBe(200), { timeout: 30_000, interval: 250 });
}, 60_000);

afterAll(async () => {
  agent?.kill();
  await fake?.close();
  if (tenantId !== undefined) {
    await db.query("DELETE FROM users WHERE tenant_id = $1", [tenantId]).catch(() => undefined);
    await db.query("DELETE FROM tenants WHERE id = $1", [tenantId]).catch(() => undefined);
  }
  await db.end().catch(() => undefined);
});

async function loginCookie(): Promise<string> {
  const response = await fetch(`${fleetApiUrl}/v1/auth/login`, {
    method: "POST",
    headers: { ...json, "x-forwarded-for": nextIp() },
    body: JSON.stringify({ email, password }),
  });
  expect(response.status).toBe(200);
  expect(sessionSchema.parse(await response.json()).tenant.tenantId).toBe(tenantId);
  const setCookie = response.headers.getSetCookie().find((cookie) => cookie.startsWith("fleet_session="));
  if (setCookie === undefined) throw new Error("el login no dejó la cookie");
  return setCookie.split(";", 1)[0] ?? "";
}

const ask = (cookie: string) =>
  fetch(`${agentUrl}/v1/chat`, {
    method: "POST",
    headers: { ...json, cookie, "x-forwarded-for": nextIp(), "x-correlation-id": `e2e-model-${runId}` },
    body: JSON.stringify({ message: QUESTION }),
  });

const healthOf = async () => {
  const response = await fetch(`${agentUrl}/health`);
  return { status: response.status, body: agentHealthResponseSchema.parse(await response.json()) };
};

describe("circuit breaker del proveedor del modelo (Anthropic falso)", () => {
  it(
    "con el proveedor sano llegan al cuerpo las 3 herramientas sin tenant, cookie ni session; el proveedor caído abre el breaker (/health 503); abierto responde 503 al instante SIN llamar al proveedor; tras el reset vuelve a 200",
    async () => {
      const cookie = await loginCookie();

      // 1) Proveedor sano: respuesta del modelo y, en el cuerpo de la petición, las tres herramientas y nada de la sesión.
      const healthy = await ask(cookie);
      expect(healthy.status).toBe(200);
      expect(chatResponseSchema.parse(await healthy.json()).answer).toContain("Anthropic falso");
      const sent = fake.requests[0]?.body;
      const tools = typeof sent === "object" && sent !== null && "tools" in sent && Array.isArray(sent.tools) ? sent.tools : [];
      expect(tools).toHaveLength(3);
      expect(JSON.stringify(tools)).not.toMatch(/tenant|cookie|session|user/i);
      // El workspace del config llega (por main.ts) al header que recibe el proveedor.
      expect(fake.requests[0]?.headers["anthropic-workspace-id"]).toBe("wrkspc_e2eFake");
      expect((await healthOf()).body.dependencies.model?.breaker).toBe("closed");

      // 2) Proveedor caído (529): cada pregunta falla con 503 y, al llegar al umbral, el circuito se abre y /health lo refleja.
      fake.mode = "overloaded";
      await vi.waitFor(
        async () => {
          const failed = await ask(cookie);
          expect(failed.status).toBe(503);
          expect(apiErrorSchema.parse(await failed.json()).error.code).toBe("agent_unavailable");
          const health = await healthOf();
          expect(health.status).toBe(503);
          expect(health.body.dependencies.model?.breaker).toBe("open");
          expect(health.body.checks["model"]).toBe("down");
        },
        { timeout: 60_000, interval: 100 },
      );

      // 3) Abierto: 503 agent_unavailable en menos de 1 s y el proveedor no recibe la petición.
      const callsWhenOpen = fake.requests.length;
      const startedAt = performance.now();
      const rejected = await ask(cookie);
      const elapsedMs = performance.now() - startedAt;
      expect(rejected.status).toBe(503);
      expect(apiErrorSchema.parse(await rejected.json()).error.code).toBe("agent_unavailable");
      expect(elapsedMs).toBeLessThan(1_000);
      expect(fake.requests.length).toBe(callsWhenOpen);

      // 4) Tras el reset el breaker pasa a halfOpen, la siguiente pregunta lo prueba con el proveedor ya sano y lo cierra.
      fake.mode = "ok";
      await vi.waitFor(
        async () => {
          const recovered = await ask(cookie);
          expect(recovered.status).toBe(200);
        },
        { timeout: 30_000, interval: 250 },
      );
      const health = await healthOf();
      expect(health.status).toBe(200);
      expect(health.body.dependencies.model?.breaker).toBe("closed");
    },
    150_000,
  );
});
