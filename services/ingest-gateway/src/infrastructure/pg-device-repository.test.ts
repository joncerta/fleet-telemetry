import { describe, expect, it } from "vitest";
import { createPgDeviceRepository, type DeviceQueryable } from "./pg-device-repository.js";

const ROW = { id: "5b8a3f6c-1e9d-4a27-8c40-7f2e6d1b9a35", tenant_id: "9d7e1b34-2a6c-4f08-b5d3-6e4a8c1f0b92", vehicle_id: "a1c4e9d2-7b3f-4c58-8e16-0d9f2b6a4c71" };
const HASH = "c".repeat(64);

function fakePool(rows: unknown[]) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const pool: DeviceQueryable = {
    query: (sql, params) => {
      queries.push({ sql, params });
      return Promise.resolve({ rows });
    },
  };
  return { pool, queries };
}

describe("createPgDeviceRepository (sin base real)", () => {
  it("consulta parametrizada por hash entre los no revocados y mapea la fila a la identidad", async () => {
    const { pool, queries } = fakePool([ROW]);

    const device = await createPgDeviceRepository(pool).findActiveByTokenHash(HASH);

    expect(device).toEqual({ deviceId: ROW.id, tenantId: ROW.tenant_id, vehicleId: ROW.vehicle_id });
    expect(queries).toHaveLength(1);
    expect(queries[0]?.params).toEqual([HASH]);
    expect(queries[0]?.sql).toMatch(/token_hash = \$1/);
    expect(queries[0]?.sql).toMatch(/revoked_at IS NULL/);
    expect(queries[0]?.sql).toMatch(/LIMIT 1/);
    expect(queries[0]?.sql).not.toContain(HASH);
  });

  it("sin filas devuelve null", async () => {
    const { pool } = fakePool([]);

    await expect(createPgDeviceRepository(pool).findActiveByTokenHash(HASH)).resolves.toBeNull();
  });

  it("propaga el error de la base", async () => {
    const pool: DeviceQueryable = { query: () => Promise.reject(new Error("conexión rechazada")) };

    await expect(createPgDeviceRepository(pool).findActiveByTokenHash(HASH)).rejects.toThrow("conexión rechazada");
  });

  it("una fila con forma inesperada falla en vez de devolver una identidad a medias", async () => {
    const { pool } = fakePool([{ id: "no-uuid" }]);

    await expect(createPgDeviceRepository(pool).findActiveByTokenHash(HASH)).rejects.toThrow();
  });
});
