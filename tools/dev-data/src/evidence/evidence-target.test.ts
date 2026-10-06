import { describe, expect, it, vi } from "vitest";
import { LocalOnlyError } from "../local-only.js";
import { connectLocalAdmin, type EvidenceConnection } from "./evidence-target.js";

function connection(mark: string | null) {
  const end = vi.fn().mockResolvedValue(undefined);
  const query = vi.fn().mockResolvedValue({ rows: [{ value: mark }] });
  const value: EvidenceConnection = { query, end };
  return { value, end, query };
}

describe("connectLocalAdmin", () => {
  it("rechaza un host no local sin conectar", async () => {
    const connect = vi.fn();

    await expect(connectLocalAdmin("postgres://admin:x@prod-db.example.com:5432/fleet", connect)).rejects.toThrow(/prod-db\.example\.com|local/);

    expect(connect).not.toHaveBeenCalled();
  });

  it("rechaza un host local sin la marca fleet.environment=local y cierra la conexión", async () => {
    const c = connection(null);

    await expect(connectLocalAdmin("postgres://admin:x@127.0.0.1:5432/fleet", () => Promise.resolve(c.value))).rejects.toBeInstanceOf(LocalOnlyError);

    expect(c.end).toHaveBeenCalledOnce();
  });

  it("acepta un host local con la marca y deja la conexión abierta", async () => {
    const c = connection("local");

    await expect(connectLocalAdmin("postgres://admin:x@localhost:5432/fleet", () => Promise.resolve(c.value))).resolves.toBe(c.value);

    expect(c.end).not.toHaveBeenCalled();
  });
});
