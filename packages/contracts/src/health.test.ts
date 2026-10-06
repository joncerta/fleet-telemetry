import { describe, expect, it } from "vitest";
import { healthResponseSchema, livenessResponseSchema } from "./health.js";
import { TOPICS } from "./topics.js";

describe("healthResponseSchema", () => {
  it("acepta el estado ok y el degradado con las dependencias que declare el servicio", () => {
    expect(healthResponseSchema.safeParse({ status: "ok", checks: { database: "up", kafka: "up" } }).success).toBe(true);
    expect(healthResponseSchema.safeParse({ status: "degraded", checks: { kafka: "down" } }).success).toBe(true);
  });

  it("rechaza un estado desconocido, una dependencia sin estado válido y la ausencia de checks", () => {
    expect(healthResponseSchema.safeParse({ status: "fail", checks: {} }).success).toBe(false);
    expect(healthResponseSchema.safeParse({ status: "ok", checks: { kafka: "maybe" } }).success).toBe(false);
    expect(healthResponseSchema.safeParse({ status: "ok" }).success).toBe(false);
  });
});

describe("livenessResponseSchema", () => {
  it("acepta solo { status: ok }", () => {
    expect(livenessResponseSchema.safeParse({ status: "ok" }).success).toBe(true);
    expect(livenessResponseSchema.safeParse({ status: "degraded" }).success).toBe(false);
    expect(livenessResponseSchema.safeParse({}).success).toBe(false);
  });
});

describe("TOPICS", () => {
  it("coincide con los tópicos que crea infra (infra/CLAUDE.md)", () => {
    expect(Object.values(TOPICS).sort()).toEqual(["fleet.alerts", "telemetry.dlq", "telemetry.raw", "vehicle.state"]);
  });
});
