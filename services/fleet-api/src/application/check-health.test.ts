import { healthResponseSchema } from "@fleet/contracts";
import { describe, expect, it } from "vitest";
import { createCheckHealth } from "./check-health.js";
import type { ReadinessCheck } from "./ports.js";

const probe = (name: string, result: boolean | Error): ReadinessCheck => ({
  name,
  check: () => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)),
});

describe("createCheckHealth", () => {
  it("es ok cuando todas las dependencias responden", async () => {
    const health = await createCheckHealth([probe("database", true), probe("kafka", true)])();

    expect(health).toEqual({ status: "ok", checks: { database: "up", kafka: "up" } });
  });

  it("es degraded e indica cuál cae cuando una no responde", async () => {
    const health = await createCheckHealth([probe("database", true), probe("kafka", false)])();

    expect(health).toEqual({ status: "degraded", checks: { database: "up", kafka: "down" } });
  });

  it("una sonda que lanza cuenta como caída y su mensaje no llega a la respuesta", async () => {
    const throwing: ReadinessCheck = {
      name: "database",
      check: () => {
        throw new Error("password authentication failed for user fleet_app");
      },
    };

    const health = await createCheckHealth([throwing, probe("kafka", new Error("SQL secreto"))])();

    expect(health).toEqual({ status: "degraded", checks: { database: "down", kafka: "down" } });
    expect(JSON.stringify(health)).not.toMatch(/password|SQL/);
  });

  it("consulta todas las dependencias en paralelo (una lenta no oculta a las demás)", async () => {
    const started: string[] = [];
    const slow = (name: string): ReadinessCheck => ({
      name,
      check: async () => {
        started.push(name);
        await Promise.resolve();
        return true;
      },
    });

    await createCheckHealth([slow("a"), slow("b")])();

    expect(started).toEqual(["a", "b"]);
  });

  it("su resultado cumple el contrato healthResponseSchema", async () => {
    const health = await createCheckHealth([probe("database", false)])();

    expect(healthResponseSchema.safeParse(health).success).toBe(true);
  });
});
