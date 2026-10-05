import { afterEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createLogger } from "../logger/logger.js";
import { createPool } from "./pool.js";

// `new Pool` no conecta hasta la primera consulta, así que estos tests no tocan la red.
const pools: Pool[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.end()));
});

function setup(overrides: Partial<Parameters<typeof createPool>[0]> = {}) {
  const lines: string[] = [];
  const logger = createLogger({ service: "t", destination: { write: (l) => void lines.push(l) } });
  const pool = createPool({
    connectionString: "postgres://user:secret-pw@127.0.0.1:1/fleet",
    applicationName: "test-service",
    logger,
    ...overrides,
  });
  pools.push(pool);
  return { pool, lines };
}

describe("createPool", () => {
  it("fija application_name, statement_timeout y sesión en UTC", () => {
    const { pool } = setup();

    expect(pool.options).toMatchObject({
      application_name: "test-service",
      statement_timeout: 15_000,
      idle_in_transaction_session_timeout: 30_000,
      options: "-c timezone=UTC",
      max: 10,
    });
  });

  it("respeta los valores que pasa el llamador", () => {
    const { pool } = setup({ statementTimeoutMs: 2_000, max: 3 });

    expect(pool.options).toMatchObject({ statement_timeout: 2_000, max: 3 });
  });

  it("registra el evento error del pool sin lanzar y sin filtrar la cadena de conexión", () => {
    const { pool, lines } = setup();

    expect(pool.listenerCount("error")).toBe(1);
    expect(() => pool.emit("error", new Error("terminating connection due to administrator command"))).not.toThrow();

    const [entry] = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(entry).toMatchObject({ level: "error", application: "test-service" });
    expect(lines.join("")).not.toContain("secret-pw");
  });
});
