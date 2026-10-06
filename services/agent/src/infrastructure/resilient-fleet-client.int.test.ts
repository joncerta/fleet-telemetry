import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger, createSessionCodec, databaseAdminConfig, defaultMigrationsDir, kafkaConfig, loadConfig, migrate } from "@fleet/platform";
import { createTempDatabase, type TempDatabase } from "@fleet/platform/testing";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { UserContext } from "../application/ports.js";
import { createResilientFleetClient } from "./resilient-fleet-client.js";

// Integración del cliente resiliente contra fleet-api REAL (levantado desde dist/ como proceso hijo) y TimescaleDB real con las migraciones
// reales: la cookie de sesión del usuario se reenvía, fleet-api filtra por el tenant de ESA cookie, los 4xx no abren el circuito y un
// fleet-api caído sí lo abre y, al volver, el circuito se cierra.

const config = loadConfig(z.object({ ...databaseAdminConfig.shape, ...kafkaConfig.shape }));
const FLEET_API_ENTRY = fileURLToPath(new URL("../../../fleet-api/dist/main.js", import.meta.url));
const SESSION_SECRET = `int-only-session-secret-${randomUUID()}`;
const codec = createSessionCodec(SESSION_SECRET);
const BREAKER = { timeoutMs: 1_500, errorThresholdPercentage: 50, volumeThreshold: 3, resetTimeoutMs: 400, rollingWindowMs: 10_000 };

const ZONE_WKT = "POLYGON((-74.075 4.705, -74.065 4.705, -74.065 4.715, -74.075 4.715, -74.075 4.705))";

let db: TempDatabase;
let logDir: string;
let child: ChildProcess | undefined;
let baseUrl: string;
let port: number;

interface Tenant {
  tenantId: string;
  plate: string;
  context: UserContext;
}

let norte: Tenant;
let sur: Tenant;

const cookieFor = (tenantId: string, expSeconds = Math.floor(Date.now() / 1_000) + 600): string =>
  codec.sign({ userId: randomUUID(), tenantId, exp: expSeconds });

const contextOf = (tenantId: string, correlationId: string, sessionToken = cookieFor(tenantId)): UserContext => ({
  identity: { userId: randomUUID(), tenantId },
  sessionToken,
  correlationId,
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const found = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(found));
    });
  });
}

function startFleetApi(): ChildProcess {
  const fd = openSync(join(logDir, "fleet-api.log"), "a");
  try {
    return spawn(process.execPath, [FLEET_API_ENTRY], {
      env: {
        ...process.env,
        DATABASE_URL: db.urlFor("fleet_app", config.FLEET_APP_PASSWORD),
        KAFKA_BROKERS: process.env["KAFKA_BROKERS"] ?? "127.0.0.1:19092",
        SESSION_SECRET,
        FLEET_API_HOST: "127.0.0.1",
        FLEET_API_PORT: String(port),
        FLEET_API_COOKIE_SECURE: "false",
        LOG_LEVEL: "info",
      },
      stdio: ["ignore", fd, fd],
      windowsHide: true,
    });
  } finally {
    closeSync(fd);
  }
}

async function stopFleetApi(): Promise<void> {
  const running = child;
  child = undefined;
  if (running === undefined || running.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => running.once("exit", () => resolve()));
  running.kill("SIGKILL");
  await exited;
}

async function waitFor<T>(what: string, probe: () => Promise<T | undefined | false>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await probe().catch(() => undefined);
    if (result !== undefined && result !== false) return result;
    if (Date.now() > deadline) throw new Error(`Se agotaron ${timeoutMs} ms esperando: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

const waitHealthy = () => waitFor("GET /health de fleet-api con 200", async () => (await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1_000) })).status === 200);

async function seedTenant(admin: Client, label: string): Promise<Tenant> {
  const tenantId = randomUUID();
  const zoneId = randomUUID();
  const vehicleId = randomUUID();
  const plate = `${label}${vehicleId.slice(0, 4).toUpperCase()}`;
  await admin.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [tenantId, `int-${label}-${tenantId}`]);
  await admin.query("INSERT INTO zones (zone_id, tenant_id, name, kind, geom) VALUES ($1, $2, $3, 'critical', ST_GeomFromText($4, 4326))", [
    zoneId,
    tenantId,
    `Zona crítica ${label}`,
    ZONE_WKT,
  ]);
  await admin.query("INSERT INTO vehicles (id, tenant_id, plate) VALUES ($1, $2, $3)", [vehicleId, tenantId, plate]);
  await admin.query(
    `INSERT INTO vehicle_state (vehicle_id, tenant_id, geom, recorded_at, received_at, speed_mps, heading_deg, movement, stopped_since, zone_ids, mocked, low_accuracy)
     VALUES ($1, $2, ST_SetSRID(ST_MakePoint(-74.07, 4.71), 4326), now(), now(), 0, NULL, 'stopped', now() - interval '60 minutes', $3::uuid[], false, false)`,
    [vehicleId, tenantId, [zoneId]],
  );
  // Una alerta activa solo para Sur: Norte no debe verla.
  if (label === "SUR") {
    await admin.query(
      "INSERT INTO alerts (alert_id, tenant_id, vehicle_id, type, zone_id, started_at, raised_at) VALUES ($1, $2, $3, 'critical_zone_stop', $4, now() - interval '40 minutes', now() - interval '20 minutes')",
      [randomUUID(), tenantId, vehicleId, zoneId],
    );
  }
  return { tenantId, plate, context: contextOf(tenantId, `int-agent-${label.toLowerCase()}`) };
}

beforeAll(async () => {
  logDir = mkdtempSync(join(tmpdir(), "agent-int-"));
  db = await createTempDatabase(config.DATABASE_ADMIN_URL);
  await migrate({
    adminUrl: db.adminUrl,
    migrationsDir: defaultMigrationsDir,
    rolePasswords: { fleet_app: config.FLEET_APP_PASSWORD, fleet_ro: config.FLEET_RO_PASSWORD },
    logger: createLogger({ service: "agent-int", level: "error" }),
  });
  const admin = new Client({ connectionString: db.adminUrl });
  await admin.connect();
  try {
    norte = await seedTenant(admin, "NORTE");
    sur = await seedTenant(admin, "SUR");
  } finally {
    await admin.end();
  }
  port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = startFleetApi();
  await waitHealthy();
}, 90_000);

afterAll(async () => {
  await stopFleetApi();
  await db.drop();
  rmSync(logDir, { recursive: true, force: true });
});

const newClient = () => createResilientFleetClient({ baseUrl, breaker: BREAKER });

describe("cliente resiliente contra fleet-api real", () => {
  it("reenvía la cookie de sesión y fleet-api filtra por el tenant de ESA cookie: cada tenant ve solo sus vehículos", async () => {
    const client = newClient();
    try {
      const forNorte = await client.stoppedVehicles(norte.context, { minMinutes: 20, zoneKind: "critical", limit: 20 });
      const forSur = await client.stoppedVehicles(sur.context, { minMinutes: 20, zoneKind: "critical", limit: 20 });

      expect(forNorte.kind).toBe("ok");
      expect(forNorte.kind === "ok" ? forNorte.data.items.map((item) => item.plate) : []).toEqual([norte.plate]);
      expect(forNorte.kind === "ok" ? forNorte.data.items[0]?.zone : undefined).toMatchObject({ name: "Zona crítica NORTE", kind: "critical" });
      expect(forSur.kind === "ok" ? forSur.data.items.map((item) => item.plate) : []).toEqual([sur.plate]);
      expect(client.breakerState()).toBe("closed");
    } finally {
      client.shutdown();
    }
  });

  it("resumen y alertas: parsean con los contratos y respetan el tenant (la alerta es solo de Sur)", async () => {
    const client = newClient();
    try {
      const summary = await client.fleetSummary(norte.context);
      const norteAlerts = await client.activeAlerts(norte.context, { limit: 20 });
      const surAlerts = await client.activeAlerts(sur.context, { limit: 20 });

      expect(summary.kind === "ok" ? summary.data.vehicles : undefined).toEqual({ total: 1, moving: 0, stopped: 1, noSignal: 0 });
      expect(norteAlerts.kind === "ok" ? norteAlerts.data.items : undefined).toEqual([]);
      expect(surAlerts.kind === "ok" ? surAlerts.data.items.map((alert) => alert.plate) : undefined).toEqual([sur.plate]);
    } finally {
      client.shutdown();
    }
  });

  it("propaga el correlationId a fleet-api", async () => {
    const client = newClient();
    const correlationId = `int-agent-corr-${randomUUID().slice(0, 8)}`;
    try {
      await client.fleetSummary({ ...norte.context, correlationId });
    } finally {
      client.shutdown();
    }

    await waitFor("el correlationId en el log de fleet-api", () => Promise.resolve(readFileSync(join(logDir, "fleet-api.log"), "utf8").includes(correlationId) || undefined));
  });

  it("una cookie inválida o vencida es un 401 de fleet-api: rejected, sin abrir el circuito aunque se repita", async () => {
    const client = newClient();
    try {
      const garbage = await client.fleetSummary({ ...norte.context, sessionToken: "basura" });
      const expired = await client.fleetSummary({ ...norte.context, sessionToken: cookieFor(norte.tenantId, Math.floor(Date.now() / 1_000) - 60) });
      for (let i = 0; i < BREAKER.volumeThreshold * 3; i++) await client.fleetSummary({ ...norte.context, sessionToken: "basura" });

      expect(garbage).toEqual({ kind: "rejected", status: 401 });
      expect(expired).toEqual({ kind: "rejected", status: 401 });
      expect(client.breakerState()).toBe("closed");
    } finally {
      client.shutdown();
    }
  });

  it("con fleet-api caído el circuito se abre y el fallback no trae datos; al volver, halfOpen y un éxito lo cierra", async () => {
    const client = newClient();
    try {
      expect((await client.fleetSummary(norte.context)).kind).toBe("ok");

      await stopFleetApi();
      for (let i = 0; i < BREAKER.volumeThreshold; i++) expect(await client.fleetSummary(norte.context)).toMatchObject({ kind: "unavailable" });
      expect(client.breakerState()).toBe("open");
      expect(await client.fleetSummary(norte.context)).toEqual({ kind: "unavailable", reason: "breaker_open" });

      child = startFleetApi();
      await waitHealthy();
      await waitFor("el breaker en halfOpen", () => Promise.resolve(client.breakerState() === "halfOpen" || undefined));
      const probe = await client.fleetSummary(norte.context);

      expect(probe.kind).toBe("ok");
      expect(client.breakerState()).toBe("closed");
    } finally {
      client.shutdown();
    }
  });
});
