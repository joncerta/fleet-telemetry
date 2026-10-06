import { deviceTokenSchema } from "@fleet/contracts";
import { sha256Hex } from "@fleet/platform";
import { describe, expect, it, vi } from "vitest";
import { generateDeviceToken, issueDeviceToken, parseVehicleArg, VehicleLookupError } from "./device-token.js";

const VEHICLE = { id: "f1ee7000-0000-4000-9000-000000001001", tenant_id: "f1ee7000-0000-4000-8000-000000000001" };

interface Call {
  sql: string;
  params: unknown[];
}

/** Pool falso: registra cada consulta y responde según la primera palabra del SQL. */
function fakePool(options: { vehicles?: { id: string; tenant_id: string }[]; revoked?: number; failOn?: string } = {}) {
  const calls: Call[] = [];
  const release = vi.fn();
  const client = {
    query: vi.fn((sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (options.failOn !== undefined && sql.startsWith(options.failOn)) return Promise.reject(new Error("boom"));
      if (sql.startsWith("SELECT")) return Promise.resolve({ rows: options.vehicles ?? [VEHICLE], rowCount: 1 });
      if (sql.startsWith("UPDATE")) return Promise.resolve({ rows: [], rowCount: options.revoked ?? 0 });
      return Promise.resolve({ rows: [], rowCount: 1 });
    }),
    release,
  };
  return { pool: { connect: vi.fn().mockResolvedValue(client) }, calls, release };
}

const verbs = (calls: Call[]) => calls.map((c) => c.sql.split(" ")[0]);

describe("generateDeviceToken", () => {
  it("respeta el formato de deviceTokenSchema: fdt_ más 32 bytes en base64url", () => {
    const token = generateDeviceToken();

    expect(deviceTokenSchema.safeParse(token).success).toBe(true);
    expect(token).toHaveLength(4 + 43);
  });

  it("no repite tokens", () => {
    expect(new Set(Array.from({ length: 200 }, generateDeviceToken)).size).toBe(200);
  });
});

describe("issueDeviceToken", () => {
  it("crea un dispositivo y guarda solo el sha256 del token, nunca el token", async () => {
    const { pool, calls, release } = fakePool();

    const issued = await issueDeviceToken(pool, "NRT101");

    const insert = calls.find((c) => c.sql.startsWith("INSERT"));
    expect(insert?.params).toEqual([issued.deviceId, VEHICLE.tenant_id, VEHICLE.id, sha256Hex(issued.token)]);
    expect(JSON.stringify(calls)).not.toContain(issued.token);
    expect(issued).toMatchObject({ vehicleId: VEHICLE.id, revokedDevices: 0 });
    expect(verbs(calls)).toEqual(["BEGIN", "SELECT", "UPDATE", "INSERT", "COMMIT"]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("al rotar revoca los activos del vehículo (por vehículo y tenant) antes de crear el nuevo", async () => {
    const { pool, calls } = fakePool({ revoked: 1 });

    const issued = await issueDeviceToken(pool, "NRT101");

    expect(issued.revokedDevices).toBe(1);
    const update = calls.find((c) => c.sql.startsWith("UPDATE"));
    expect(update?.sql).toContain("revoked_at IS NULL");
    expect(update?.params).toEqual([VEHICLE.id, VEHICLE.tenant_id]);
    expect(verbs(calls).indexOf("UPDATE")).toBeLessThan(verbs(calls).indexOf("INSERT"));
  });

  it("busca por id cuando recibe un UUID y por placa normalizada en cualquier otro caso", async () => {
    const byId = fakePool();
    await issueDeviceToken(byId.pool, VEHICLE.id.toUpperCase());
    const byPlate = fakePool();
    await issueDeviceToken(byPlate.pool, " nrt101 ");

    expect(byId.calls[1]?.sql).toContain("WHERE id = $1");
    expect(byId.calls[1]?.params).toEqual([VEHICLE.id]);
    expect(byPlate.calls[1]?.sql).toContain("WHERE plate = $1");
    expect(byPlate.calls[1]?.params).toEqual(["NRT101"]);
  });

  it("falla sin escribir nada si el vehículo no existe o la placa es ambigua, y revierte", async () => {
    const missing = fakePool({ vehicles: [] });
    await expect(issueDeviceToken(missing.pool, "ZZZ999")).rejects.toBeInstanceOf(VehicleLookupError);
    expect(verbs(missing.calls)).toEqual(["BEGIN", "SELECT", "ROLLBACK"]);

    const ambiguous = fakePool({ vehicles: [VEHICLE, { ...VEHICLE, tenant_id: "f1ee7000-0000-4000-8000-000000000002" }] });
    await expect(issueDeviceToken(ambiguous.pool, "NRT101")).rejects.toThrow(/usa el id/);
    expect(verbs(ambiguous.calls)).not.toContain("INSERT");
    expect(ambiguous.release).toHaveBeenCalledOnce();
  });

  it("si el INSERT falla revierte (el dispositivo anterior no queda revocado) y libera el client", async () => {
    const { pool, calls, release } = fakePool({ failOn: "INSERT" });

    await expect(issueDeviceToken(pool, "NRT101")).rejects.toThrow("boom");

    expect(calls.at(-1)?.sql).toBe("ROLLBACK");
    expect(calls.some((c) => c.sql === "COMMIT")).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });
});

describe("parseVehicleArg", () => {
  it("lee --vehicle, con o sin el -- que deja pnpm", () => {
    expect(parseVehicleArg(["--vehicle", "NRT101"])).toBe("NRT101");
    expect(parseVehicleArg(["--", "--vehicle", "NRT101"])).toBe("NRT101");
  });

  it("falla con uso incorrecto: sin valor, sin flag, flag como valor o argumentos de más", () => {
    for (const argv of [[], ["--vehicle"], ["--vehicle", ""], ["--vehicle", "--otro"], ["NRT101"], ["--vehicle", "A", "extra"]]) {
      expect(() => parseVehicleArg(argv)).toThrow(/Uso: pnpm device:token/);
    }
  });
});
