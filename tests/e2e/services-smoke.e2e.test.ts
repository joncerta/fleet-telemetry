import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { apiErrorSchema, healthResponseSchema, livenessResponseSchema, TOPICS } from "@fleet/contracts";
import { createAdmin, createKafka, createLogger, loadConfig } from "@fleet/platform";
import { AssignerProtocol, type Admin } from "kafkajs";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { z } from "zod";
import { processorIsConsuming } from "./harness.js";
import "./provided-context.js";
import { e2eConfigSchema } from "./support.js";

// Smoke de los servicios que levantó el arnés (global-setup.ts) desde dist/, con su puerto y su consumer group propios.
// Todavía no hay flujos de negocio (la ingesta llega con sus casos de uso): esto prueba que el arnés y el cableado base
// funcionan contra el stack real.
const gatewayUrl = inject("gatewayUrl");
const fleetApiUrl = inject("fleetApiUrl");
const processorGroup = inject("processorGroup");
const runId = inject("runId");
const rawBacklogEnd = inject("rawBacklogEnd");
const logDir = inject("serviceLogDir");
const config = loadConfig(e2eConfigSchema);

let admin: Admin;

beforeAll(async () => {
  const kafka = createKafka({
    brokers: config.KAFKA_BROKERS,
    clientId: `e2e-services-smoke-${randomUUID().slice(0, 8)}`,
    logger: createLogger({ service: "e2e-services-smoke", level: "error" }),
  });
  admin = createAdmin(kafka);
  await admin.connect();
});

afterAll(async () => {
  await admin.disconnect();
});

describe("ingest-gateway levantado desde dist/", () => {
  it("usa el puerto propio del e2e, no el 4001 de pnpm dev", () => {
    expect(new URL(gatewayUrl).port).toBe("14001");
  });

  it("GET /health responde 200 con la base y el productor de Kafka arriba, sin datos sensibles", async () => {
    const response = await fetch(`${gatewayUrl}/health`);

    expect(response.status).toBe(200);
    const health = healthResponseSchema.parse(await response.json());
    expect(health).toEqual({ status: "ok", checks: { database: "up", kafka: "up" } });
    expect(JSON.stringify(health)).not.toMatch(/postgres|127\.0\.0\.1|password|fleet_app/i);
  });

  it("GET /health/live responde 200 { status: ok } sin consultar dependencias", async () => {
    const response = await fetch(`${gatewayUrl}/health/live`);

    expect(response.status).toBe(200);
    expect(livenessResponseSchema.parse(await response.json())).toEqual({ status: "ok" });
  });

  it("una ruta inexistente responde 404 con el formato de apiErrorSchema y devuelve el correlationId recibido", async () => {
    const correlationId = `e2e-${randomUUID()}`;

    const response = await fetch(`${gatewayUrl}/no-existe`, { headers: { "x-correlation-id": correlationId } });

    expect(response.status).toBe(404);
    expect(apiErrorSchema.parse(await response.json()).error.code).toBe("not_found");
    expect(response.headers.get("x-correlation-id")).toBe(correlationId);
  });

  it("reemplaza un correlationId inválido por uno generado", async () => {
    const response = await fetch(`${gatewayUrl}/health`, { headers: { "x-correlation-id": "no válido: con espacios" } });

    expect(response.headers.get("x-correlation-id")).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("fleet-api levantado desde dist/", () => {
  it("usa el puerto propio del e2e, no el 4002 de pnpm dev", () => {
    expect(new URL(fleetApiUrl).port).toBe("14002");
  });

  it("GET /health responde 200 con la base y el consumer del SSE arriba, sin datos sensibles", async () => {
    const response = await fetch(`${fleetApiUrl}/health`);

    expect(response.status).toBe(200);
    const health = healthResponseSchema.parse(await response.json());
    expect(health).toEqual({ status: "ok", checks: { database: "up", "sse-feed": "up" } });
    expect(JSON.stringify(health)).not.toMatch(/postgres|127\.0\.0\.1|password|fleet_app|secret/i);
  });

  it("GET /health/live responde 200 { status: ok } sin consultar dependencias", async () => {
    const response = await fetch(`${fleetApiUrl}/health/live`);

    expect(response.status).toBe(200);
    expect(livenessResponseSchema.parse(await response.json())).toEqual({ status: "ok" });
  });

  it("su consumer del SSE tiene un grupo PROPIO (fleet-api-sse-<instancia>, distinto del processor), estable y con las particiones de vehicle.state y fleet.alerts", async () => {
    const groupId = `fleet-api-sse-e2e-${runId}`;

    const { groups } = await admin.describeGroups([groupId]);

    const group = groups.find((candidate) => candidate.groupId === groupId);
    expect(group?.state).toBe("Stable");
    expect(group?.members).toHaveLength(1);
    const member = group?.members[0];
    const assignment = member === undefined ? undefined : AssignerProtocol.MemberAssignment.decode(member.memberAssignment)?.assignment;
    expect(assignment?.[TOPICS.vehicleState]?.length ?? 0).toBeGreaterThan(0);
    expect(assignment?.[TOPICS.fleetAlerts]?.length ?? 0).toBeGreaterThan(0);
    expect(groupId).not.toBe(processorGroup);
  });

  it("una ruta inexistente responde 404 con apiErrorSchema y devuelve el correlationId recibido", async () => {
    const correlationId = `e2e-${randomUUID()}`;

    const response = await fetch(`${fleetApiUrl}/no-existe`, { headers: { "x-correlation-id": correlationId } });

    expect(response.status).toBe(404);
    expect(apiErrorSchema.parse(await response.json()).error.code).toBe("not_found");
    expect(response.headers.get("x-correlation-id")).toBe(correlationId);
  });

  it("una lectura sin sesión responde 401", async () => {
    const response = await fetch(`${fleetApiUrl}/v1/summary`);

    expect(response.status).toBe(401);
    expect(apiErrorSchema.parse(await response.json()).error.code).toBe("unauthorized");
  });
});

describe("processor levantado desde dist/", () => {
  it("consume telemetry.raw con el consumer group propio del e2e (estable y con particiones asignadas)", async () => {
    expect(processorGroup).toMatch(/^processor-e2e-[0-9a-f]{8}$/);

    await expect(processorIsConsuming(admin, processorGroup)).resolves.toBe(true);
  });

  // Hallazgo M-d: un grupo nuevo con fromBeginning leería todo telemetry.raw (días de corridas anteriores), republicaría sus rechazos en la
  // DLQ y reinsertaría telemetría de tenants e2e ya borrados. El arnés fija los offsets del grupo al final ANTES de lanzar el processor.
  // Ojo: con `telemetry.raw` vacío (un CI limpio) este test pasa aunque el anclaje no haga nada; quien prueba `pinGroupToTopicEnd`
  // con un backlog real es `harness-anchor.e2e.test.ts`.
  it("arranca anclado al final de telemetry.raw: ningún tramo procesado empieza antes del fin que tenía el tópico al anclar el grupo", () => {
    expect(Object.keys(rawBacklogEnd).sort()).toEqual(["0", "1", "2"]);
    const chunks = readFileSync(join(logDir, "processor.log"), "utf8")
      .split("\n")
      .filter((line) => line.includes("Tramo de telemetría procesado"))
      .map((line) => z.object({ partition: z.number(), firstOffset: z.string() }).parse(JSON.parse(line)));

    const readBacklog = chunks.filter(({ partition, firstOffset }) => BigInt(firstOffset) < BigInt(rawBacklogEnd[String(partition)] ?? "0"));

    expect(readBacklog).toEqual([]);
  });

  it("no usa el grupo processor de pnpm dev", async () => {
    const { groups } = await admin.describeGroups([processorGroup]);

    expect(groups.map((group) => group.groupId)).toEqual([processorGroup]);
    expect(processorGroup).not.toBe("processor");
  });
});

describe("logs de los servicios", () => {
  it("quedan en un archivo por servicio en la carpeta de la corrida", () => {
    expect(existsSync(logDir)).toBe(true);
    expect(readdirSync(logDir).sort()).toEqual(["agent.log", "fleet-api.log", "ingest-gateway.log", "processor.log"]);
    expect(existsSync(join(logDir, "ingest-gateway.log"))).toBe(true);
  });
});
