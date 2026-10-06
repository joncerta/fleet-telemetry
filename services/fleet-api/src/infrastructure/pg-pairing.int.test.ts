import { randomUUID } from "node:crypto";
import { PAIRING_CODE_LENGTH } from "@fleet/contracts";
import { sha256Hex } from "@fleet/platform";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCreatePairingCode } from "../application/create-pairing-code.js";
import { InvalidPairingCodeError, VehicleNotFoundError } from "../application/errors.js";
import { createPairDevice } from "../application/pair-device.js";
import type { PairingCredentials } from "../application/ports.js";
import { createIntegrationDatabase, createSeeder, type IntegrationDatabase, type Seeder } from "../testing/integration-db.js";
import { createCryptoPairingCredentials } from "./crypto-pairing-credentials.js";
import { createPgPairingCodeRepository, createPgPairingUnitOfWork } from "./pg-pairing.js";

// Contra la base real, con el rol de los servicios (fleet_app): el canje es una transacción con UPDATE condicional, y el índice único parcial de
// la migración 004 (un solo dispositivo activo por vehículo) debe convivir con la rotación y con canjes simultáneos.
let db: IntegrationDatabase;
let seed: Seeder;

beforeAll(async () => {
  db = await createIntegrationDatabase("fleet-api-pairing-it");
  seed = createSeeder(db.pool);
});

afterAll(async () => {
  await db?.close();
});

const credentials = createCryptoPairingCredentials();

const codeRepository = () => createPgPairingCodeRepository(db.pool);
const pairDevice = (overrides: Partial<PairingCredentials> = {}) =>
  createPairDevice({ unitOfWork: createPgPairingUnitOfWork(db.pool), credentials: { ...credentials, ...overrides }, hash: sha256Hex });
const createCode = (ttlMinutes = 10) => createCreatePairingCode({ codes: codeRepository(), credentials, hash: sha256Hex, ttlMinutes });

interface Fleet {
  tenantId: string;
  userId: string;
  vehicleId: string;
}

async function makeFleet(): Promise<Fleet> {
  const tenantId = await seed.tenant();
  return { tenantId, userId: (await seed.user(tenantId)).userId, vehicleId: await seed.vehicle(tenantId, "ABC123") };
}

const activeDevices = async (vehicleId: string) =>
  (await db.pool.query<{ id: string; token_hash: string }>("SELECT id, token_hash FROM devices WHERE vehicle_id = $1 AND revoked_at IS NULL", [vehicleId])).rows;

describe("crear un código de vinculación", () => {
  it("guarda SOLO el hash del código (nunca el código), con el vencimiento de la base y el creador", async () => {
    const fleet = await makeFleet();

    const created = await createCode(10)({ identity: fleet, vehicleId: fleet.vehicleId });

    expect(created.code).toHaveLength(PAIRING_CODE_LENGTH);
    const { rows } = await db.pool.query<{ code_hash: string; created_by: string; tenant_id: string; minutes: number }>(
      "SELECT code_hash, created_by, tenant_id, extract(epoch FROM (expires_at - now())) / 60 AS minutes FROM device_pairing_codes WHERE vehicle_id = $1",
      [fleet.vehicleId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ code_hash: sha256Hex(created.code), created_by: fleet.userId, tenant_id: fleet.tenantId });
    expect(Number(rows[0]?.minutes)).toBeGreaterThan(9);
    expect(Number(rows[0]?.minutes)).toBeLessThanOrEqual(10);
    expect(new Date(created.expiresAt).getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);
    const dump = JSON.stringify((await db.pool.query("SELECT * FROM device_pairing_codes")).rows);
    expect(dump).not.toContain(created.code);
  });

  it("el TTL es configurable", async () => {
    const fleet = await makeFleet();

    const created = await createCode(1)({ identity: fleet, vehicleId: fleet.vehicleId });

    expect(new Date(created.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 60_000 + 1_000);
  });

  it("un vehículo de OTRO tenant es VehicleNotFoundError y no deja ningún código", async () => {
    const [mine, theirs] = [await makeFleet(), await makeFleet()];

    await expect(createCode()({ identity: mine, vehicleId: theirs.vehicleId })).rejects.toBeInstanceOf(VehicleNotFoundError);
    await expect(createCode()({ identity: mine, vehicleId: randomUUID() })).rejects.toBeInstanceOf(VehicleNotFoundError);

    const { rows } = await db.pool.query("SELECT 1 FROM device_pairing_codes WHERE vehicle_id = $1", [theirs.vehicleId]);
    expect(rows).toHaveLength(0);
  });

  it("ante una colisión del hash reintenta con otro código", async () => {
    const fleet = await makeFleet();
    const first = await createCode()({ identity: fleet, vehicleId: fleet.vehicleId });
    const queue = [first.code, "QQQQQQQQ"];
    const colliding: PairingCredentials = { ...credentials, newPairingCode: () => queue.shift() ?? "ZZZZZZZZ" };

    const second = await createCreatePairingCode({ codes: codeRepository(), credentials: colliding, hash: sha256Hex, ttlMinutes: 10 })({
      identity: fleet,
      vehicleId: fleet.vehicleId,
    });

    expect(second.code).toBe("QQQQQQQQ");
  });
});

describe("canjear un código", () => {
  it("crea el dispositivo con el hash del token, marca el código como usado y el token sirve para el gateway", async () => {
    const fleet = await makeFleet();
    const { code } = await createCode()({ identity: fleet, vehicleId: fleet.vehicleId });

    const paired = await pairDevice()({ code });

    expect(paired.response).toMatchObject({ vehicleId: fleet.vehicleId, plate: "ABC123" });
    expect(paired.tenantId).toBe(fleet.tenantId);
    // Lo que hace el gateway para autenticar: busca por el hash del token entre los no revocados.
    const gatewayLookup = await db.pool.query<{ id: string; tenant_id: string; vehicle_id: string }>(
      "SELECT id, tenant_id, vehicle_id FROM devices WHERE token_hash = $1 AND revoked_at IS NULL",
      [sha256Hex(paired.response.deviceToken)],
    );
    expect(gatewayLookup.rows).toEqual([{ id: paired.deviceId, tenant_id: fleet.tenantId, vehicle_id: fleet.vehicleId }]);
    const used = await db.pool.query<{ used_at: Date | null }>("SELECT used_at FROM device_pairing_codes WHERE code_hash = $1", [sha256Hex(code)]);
    expect(used.rows[0]?.used_at).toBeInstanceOf(Date);
    // El token en claro no está en ninguna tabla.
    expect(JSON.stringify((await db.pool.query("SELECT * FROM devices WHERE vehicle_id = $1", [fleet.vehicleId])).rows)).not.toContain(paired.response.deviceToken);
  });

  it("el mismo código usado otra vez es InvalidPairingCodeError y no crea otro dispositivo", async () => {
    const fleet = await makeFleet();
    const { code } = await createCode()({ identity: fleet, vehicleId: fleet.vehicleId });
    await pairDevice()({ code });

    await expect(pairDevice()({ code })).rejects.toBeInstanceOf(InvalidPairingCodeError);

    expect(await activeDevices(fleet.vehicleId)).toHaveLength(1);
  });

  it("un código inexistente y uno vencido dan el MISMO error que uno usado", async () => {
    const fleet = await makeFleet();
    const { code } = await createCode()({ identity: fleet, vehicleId: fleet.vehicleId });
    await db.pool.query("UPDATE device_pairing_codes SET expires_at = now() - interval '1 second' WHERE code_hash = $1", [sha256Hex(code)]);

    const errors = await Promise.all([pairDevice()({ code }), pairDevice()({ code: "ZZZZZZZZ" })].map((attempt) => attempt.catch((error: unknown) => error)));

    for (const error of errors) expect(error).toBeInstanceOf(InvalidPairingCodeError);
    expect(errors.map((error) => (error instanceof Error ? error.message : ""))).toEqual([expect.any(String), expect.any(String)]);
    expect(new Set(errors.map((error) => (error instanceof Error ? error.message : ""))).size).toBe(1);
    const state = await db.pool.query<{ used_at: Date | null }>("SELECT used_at FROM device_pairing_codes WHERE code_hash = $1", [sha256Hex(code)]);
    expect(state.rows[0]?.used_at).toBeNull();
    expect(await activeDevices(fleet.vehicleId)).toHaveLength(0);
  });

  it("revoca el dispositivo activo del vehículo: queda UNO solo activo y es el nuevo", async () => {
    const fleet = await makeFleet();
    const oldDevice = randomUUID();
    const oldToken = `token-viejo-${randomUUID()}`;
    await db.pool.query("INSERT INTO devices (id, tenant_id, vehicle_id, token_hash) VALUES ($1, $2, $3, $4)", [oldDevice, fleet.tenantId, fleet.vehicleId, sha256Hex(oldToken)]);
    const { code } = await createCode()({ identity: fleet, vehicleId: fleet.vehicleId });

    const paired = await pairDevice()({ code });

    const active = await activeDevices(fleet.vehicleId);
    expect(active.map((device) => device.id)).toEqual([paired.deviceId]);
    const revoked = await db.pool.query<{ revoked_at: Date | null }>("SELECT revoked_at FROM devices WHERE id = $1", [oldDevice]);
    expect(revoked.rows[0]?.revoked_at).toBeInstanceOf(Date);
  });

  it("si falla la creación del dispositivo, TODO se revierte: el código sigue vigente y el dispositivo viejo sigue activo", async () => {
    const fleet = await makeFleet();
    const oldDevice = randomUUID();
    const oldToken = `token-viejo-${randomUUID()}`;
    await db.pool.query("INSERT INTO devices (id, tenant_id, vehicle_id, token_hash) VALUES ($1, $2, $3, $4)", [oldDevice, fleet.tenantId, fleet.vehicleId, sha256Hex(oldToken)]);
    const { code } = await createCode()({ identity: fleet, vehicleId: fleet.vehicleId });
    // Un token cuyo hash ya existe (devices_token_hash_key) hace fallar el INSERT después de canjear el código y revocar el viejo.
    const duplicated = await pairDevice({ newDeviceToken: () => oldToken })({ code }).catch((error: unknown) => error);

    expect(duplicated).toMatchObject({ code: "23505" });
    const state = await db.pool.query<{ used_at: Date | null }>("SELECT used_at FROM device_pairing_codes WHERE code_hash = $1", [sha256Hex(code)]);
    expect(state.rows[0]?.used_at).toBeNull();
    expect((await activeDevices(fleet.vehicleId)).map((device) => device.id)).toEqual([oldDevice]);
    // Y el código se puede canjear después, con un token bueno.
    await expect(pairDevice()({ code })).resolves.toMatchObject({ tenantId: fleet.tenantId });
  });

  it("dos canjes SIMULTÁNEOS del mismo código: exactamente uno gana", async () => {
    const fleet = await makeFleet();
    const { code } = await createCode()({ identity: fleet, vehicleId: fleet.vehicleId });

    const results = await Promise.allSettled(Array.from({ length: 5 }, () => pairDevice()({ code })));

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results.filter((candidate) => candidate.status === "rejected")) expect(result.reason).toBeInstanceOf(InvalidPairingCodeError);
    expect(await activeDevices(fleet.vehicleId)).toHaveLength(1);
  });

  it("dos códigos DISTINTOS del mismo vehículo canjeados a la vez: ambos terminan y queda UN solo dispositivo activo", async () => {
    const fleet = await makeFleet();
    const [a, b] = [await createCode()({ identity: fleet, vehicleId: fleet.vehicleId }), await createCode()({ identity: fleet, vehicleId: fleet.vehicleId })];

    const results = await Promise.allSettled([pairDevice()({ code: a.code }), pairDevice()({ code: b.code })]);

    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await activeDevices(fleet.vehicleId)).toHaveLength(1);
  });

  it("el canje usa el tenant del código: dos tenants con la misma placa no se mezclan", async () => {
    const [a, b] = [await makeFleet(), await makeFleet()];
    const [codeA, codeB] = [await createCode()({ identity: a, vehicleId: a.vehicleId }), await createCode()({ identity: b, vehicleId: b.vehicleId })];

    const [pairedA, pairedB] = [await pairDevice()({ code: codeA.code }), await pairDevice()({ code: codeB.code })];

    expect([pairedA.tenantId, pairedA.response.vehicleId]).toEqual([a.tenantId, a.vehicleId]);
    expect([pairedB.tenantId, pairedB.response.vehicleId]).toEqual([b.tenantId, b.vehicleId]);
  });
});
