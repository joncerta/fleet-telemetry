import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createPgPairingCodeRepository, createPgPairingUnitOfWork, type PairingClient } from "./pg-pairing.js";

type QueryResult = { rows: unknown[]; rowCount: number | null };

/** Conexión falsa: anota las sentencias y responde con lo que decida `respond`. */
function makeClient(respond: (sql: string, params: unknown[]) => QueryResult | Error = () => ({ rows: [], rowCount: 0 })) {
  const statements: string[] = [];
  const query = vi.fn((sql: string, params: unknown[]) => {
    statements.push(sql.trim().split(/\s+/, 2).join(" "));
    const result = respond(sql, params);
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  });
  const release = vi.fn<PairingClient["release"]>();
  const client: PairingClient = { query, release };
  return { client, statements, query, release };
}

const poolOf = (client: PairingClient) => ({ connect: () => Promise.resolve(client) });

describe("createPgPairingUnitOfWork", () => {
  it("abre la transacción, corre el trabajo, la confirma y libera la conexión", async () => {
    const { client, statements, release } = makeClient();

    const result = await createPgPairingUnitOfWork(poolOf(client)).run(() => Promise.resolve("listo"));

    expect(result).toBe("listo");
    expect(statements).toEqual(["BEGIN", "COMMIT"]);
    expect(release).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("si el trabajo lanza, revierte (sin COMMIT), propaga el error original y libera la conexión", async () => {
    const { client, statements, release } = makeClient();
    const failure = new Error("unique violation");

    await expect(createPgPairingUnitOfWork(poolOf(client)).run(() => Promise.reject(failure))).rejects.toBe(failure);

    expect(statements).toEqual(["BEGIN", "ROLLBACK"]);
    expect(release).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("si el ROLLBACK mismo falla, destruye la conexión en vez de devolverla al pool, y sigue subiendo el error original", async () => {
    const { client, release } = makeClient((sql) => (sql === "ROLLBACK" ? new Error("conexión caída") : { rows: [], rowCount: 0 }));
    const failure = new Error("trabajo fallido");

    await expect(createPgPairingUnitOfWork(poolOf(client)).run(() => Promise.reject(failure))).rejects.toBe(failure);

    expect(release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("si COMMIT falla, revierte y libera", async () => {
    const { client, statements, release } = makeClient((sql) => (sql === "COMMIT" ? new Error("commit falló") : { rows: [], rowCount: 0 }));

    await expect(createPgPairingUnitOfWork(poolOf(client)).run(() => Promise.resolve(1))).rejects.toThrow("commit falló");

    expect(statements).toEqual(["BEGIN", "COMMIT", "ROLLBACK"]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("las operaciones del canje van por la MISMA conexión y con parámetros (nunca el valor dentro del SQL)", async () => {
    const tenantId = randomUUID();
    const vehicleId = randomUUID();
    const hash = "a".repeat(64);
    const { client, query } = makeClient((sql) => {
      if (sql.includes("UPDATE device_pairing_codes")) return { rows: [{ tenant_id: tenantId, vehicle_id: vehicleId }], rowCount: 1 };
      if (sql.includes("FOR NO KEY UPDATE")) return { rows: [{ plate: "ABC123" }], rowCount: 1 };
      if (sql.includes("INSERT INTO devices")) return { rows: [{ created_at: new Date("2026-10-06T12:00:00.000Z") }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    const result = await createPgPairingUnitOfWork(poolOf(client)).run(async (tx) => {
      const code = await tx.consumeCode(hash);
      const vehicle = await tx.lockVehicle(tenantId, vehicleId);
      await tx.revokeActiveDevices(tenantId, vehicleId);
      const device = await tx.insertDevice({ deviceId: randomUUID(), tenantId, vehicleId, tokenHash: "b".repeat(64) });
      return { code, vehicle, device };
    });

    expect(result).toEqual({
      code: { tenantId, vehicleId },
      vehicle: { plate: "ABC123" },
      device: { createdAt: new Date("2026-10-06T12:00:00.000Z") },
    });
    for (const [sql, params] of query.mock.calls) {
      if (sql === "BEGIN" || sql === "COMMIT") continue;
      expect(sql).toMatch(/\$1/);
      expect(Array.isArray(params)).toBe(true);
      expect(sql).not.toContain(hash);
      expect(sql).not.toContain(tenantId);
    }
  });

  it("consumeCode devuelve null si el UPDATE condicional no actualizó nada", async () => {
    const { client } = makeClient();

    const consumed = await createPgPairingUnitOfWork(poolOf(client)).run((tx) => tx.consumeCode("c".repeat(64)));

    expect(consumed).toBeNull();
  });
});

describe("createPgPairingCodeRepository.create", () => {
  const input = { tenantId: randomUUID(), vehicleId: randomUUID(), createdBy: randomUUID(), codeHash: "d".repeat(64), ttlMinutes: 10 };

  it("created: devuelve el vencimiento de la base", async () => {
    const expiresAt = new Date("2026-10-06T12:10:00.000Z");
    const { client } = makeClient(() => ({ rows: [{ expires_at: expiresAt }], rowCount: 1 }));

    await expect(createPgPairingCodeRepository(client).create(input)).resolves.toEqual({ status: "created", expiresAt });
  });

  it("sin fila insertada y sin vehículo del tenant: vehicle_not_found", async () => {
    const { client, query } = makeClient();

    await expect(createPgPairingCodeRepository(client).create(input)).resolves.toEqual({ status: "vehicle_not_found" });

    // La comprobación del vehículo filtra por el tenant del llamador: no revela vehículos de otros tenants.
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining("tenant_id = $2"), [input.vehicleId, input.tenantId]);
  });

  it("sin fila insertada pero con el vehículo del tenant: code_collision", async () => {
    const { client } = makeClient((sql) => (sql.includes("SELECT 1 FROM vehicles") ? { rows: [{ "?column?": 1 }], rowCount: 1 } : { rows: [], rowCount: 0 }));

    await expect(createPgPairingCodeRepository(client).create(input)).resolves.toEqual({ status: "code_collision" });
  });

  it("guarda solo el hash: el código en claro nunca llega a este adaptador", async () => {
    const { client, query } = makeClient(() => ({ rows: [{ expires_at: new Date() }], rowCount: 1 }));

    await createPgPairingCodeRepository(client).create(input);

    expect(query).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("INSERT INTO device_pairing_codes"), [input.codeHash, input.tenantId, input.vehicleId, input.createdBy, 10]);
  });
});
