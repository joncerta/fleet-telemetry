import { randomUUID } from "node:crypto";
import { sha256Hex } from "@fleet/platform";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCreatePairingCode } from "../application/create-pairing-code.js";
import { createPairDevice } from "../application/pair-device.js";
import { createIntegrationDatabase, createSeeder, type IntegrationDatabase, type Seeder } from "../testing/integration-db.js";
import { createCryptoPairingCredentials } from "./crypto-pairing-credentials.js";
import { createPgPairingCodeRepository, createPgPairingUnitOfWork } from "./pg-pairing.js";
import { createPgTenantUserReader } from "./pg-tenant-users.js";
import { createPgVehicleCatalogRepository } from "./pg-vehicle-catalog.js";

// Contra la base real, con el rol de los servicios (fleet_app): la unicidad (tenant, placa), el aislamiento entre tenants, hasActiveDevice y el
// pairing de un vehículo recién creado, sin fila en vehicle_state.
let db: IntegrationDatabase;
let seed: Seeder;

beforeAll(async () => {
  db = await createIntegrationDatabase("fleet-api-vehicle-catalog-it");
  seed = createSeeder(db.pool);
});

afterAll(async () => {
  await db?.close();
});

const catalog = () => createPgVehicleCatalogRepository(db.pool);

describe("createPgVehicleCatalogRepository.create", () => {
  it("inserta el vehículo en el tenant, sin dispositivo, con createdAt de la base", async () => {
    const tenantId = await seed.tenant();
    const vehicleId = randomUUID();

    const result = await catalog().create({ tenantId, vehicleId, plate: "ABC123", label: "Camión 7" });

    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    expect(result.vehicle).toMatchObject({ vehicleId, plate: "ABC123", label: "Camión 7", hasActiveDevice: false });
    expect(Number.isNaN(Date.parse(result.vehicle.createdAt))).toBe(false);
    const stored = await db.pool.query<{ tenant_id: string }>("SELECT tenant_id FROM vehicles WHERE id = $1", [vehicleId]);
    expect(stored.rows[0]?.tenant_id).toBe(tenantId);
  });

  it("la etiqueta null se guarda como null", async () => {
    const tenantId = await seed.tenant();

    const result = await catalog().create({ tenantId, vehicleId: randomUUID(), plate: "NUL001", label: null });

    expect(result.status === "created" && result.vehicle.label).toBeNull();
  });

  it("una placa repetida en el mismo tenant es plate_taken y no inserta nada", async () => {
    const tenantId = await seed.tenant();
    await catalog().create({ tenantId, vehicleId: randomUUID(), plate: "DUP123", label: null });

    const second = await catalog().create({ tenantId, vehicleId: randomUUID(), plate: "DUP123", label: "otro" });

    expect(second).toEqual({ status: "plate_taken" });
    const count = await db.pool.query<{ n: string }>("SELECT count(*) AS n FROM vehicles WHERE tenant_id = $1 AND plate = 'DUP123'", [tenantId]);
    expect(Number(count.rows[0]?.n)).toBe(1);
  });

  it("la misma placa en OTRO tenant es válida", async () => {
    const [a, b] = [await seed.tenant(), await seed.tenant()];

    expect((await catalog().create({ tenantId: a, vehicleId: randomUUID(), plate: "SAME01", label: null })).status).toBe("created");
    expect((await catalog().create({ tenantId: b, vehicleId: randomUUID(), plate: "SAME01", label: null })).status).toBe("created");
  });

  it("dos altas simultáneas de la misma placa: una gana y la otra es plate_taken (sin error de pg)", async () => {
    const tenantId = await seed.tenant();

    const results = await Promise.all(
      Array.from({ length: 4 }, () => catalog().create({ tenantId, vehicleId: randomUUID(), plate: "RACE01", label: null })),
    );

    expect(results.filter((r) => r.status === "created")).toHaveLength(1);
    expect(results.filter((r) => r.status === "plate_taken")).toHaveLength(3);
  });

  it("una placa con forma de inyección SQL se guarda como dato", async () => {
    const tenantId = await seed.tenant();
    const plate = "X'; DROP TABLE vehicles;--";

    const result = await catalog().create({ tenantId, vehicleId: randomUUID(), plate, label: null });

    expect(result.status).toBe("created");
    await expect(db.pool.query("SELECT 1 FROM vehicles LIMIT 1")).resolves.toBeDefined();
  });
});

describe("createPgVehicleCatalogRepository.list", () => {
  it("lista SOLO los vehículos del tenant, ordenados por placa, con o sin estado de telemetría", async () => {
    const [a, b] = [await seed.tenant(), await seed.tenant()];
    await seed.vehicle(a, "CCC333");
    await seed.vehicle(a, "AAA111");
    const withState = await seed.vehicle(a, "BBB222");
    await seed.state(a, withState);
    await seed.vehicle(b, "ZZZ999");

    const items = await catalog().list(a, 50);

    expect(items.map((item) => item.plate)).toEqual(["AAA111", "BBB222", "CCC333"]);
    expect(items.every((item) => item.hasActiveDevice === false)).toBe(true);
    expect(items.some((item) => item.plate === "ZZZ999")).toBe(false);
    expect(await catalog().list(randomUUID(), 50)).toEqual([]);
  });

  it("respeta el limit", async () => {
    const tenantId = await seed.tenant();
    for (const plate of ["L01", "L02", "L03"]) await seed.vehicle(tenantId, plate);

    expect((await catalog().list(tenantId, 2)).map((item) => item.plate)).toEqual(["L01", "L02"]);
  });

  it("hasActiveDevice es true con un dispositivo sin revocar y false con uno revocado; una etiqueta vacía se lee como null", async () => {
    const tenantId = await seed.tenant();
    const active = await seed.vehicle(tenantId, "ACT001");
    const revoked = await seed.vehicle(tenantId, "REV001");
    await db.pool.query("INSERT INTO devices (id, tenant_id, vehicle_id, token_hash) VALUES ($1, $2, $3, $4)", [randomUUID(), tenantId, active, sha256Hex(randomUUID())]);
    await db.pool.query("INSERT INTO devices (id, tenant_id, vehicle_id, token_hash, revoked_at) VALUES ($1, $2, $3, $4, now())", [randomUUID(), tenantId, revoked, sha256Hex(randomUUID())]);
    await db.pool.query("UPDATE vehicles SET label = '   ' WHERE id = $1", [revoked]);

    const items = await catalog().list(tenantId, 50);

    expect(items.find((item) => item.vehicleId === active)?.hasActiveDevice).toBe(true);
    const revokedItem = items.find((item) => item.vehicleId === revoked);
    expect(revokedItem?.hasActiveDevice).toBe(false);
    expect(revokedItem?.label).toBeNull();
  });

  it("un dispositivo de un vehículo de otro tenant no marca al vehículo (filtro por tenant)", async () => {
    const [a, b] = [await seed.tenant(), await seed.tenant()];
    const own = await seed.vehicle(a, "OWN001");
    await db.pool.query("INSERT INTO devices (id, tenant_id, vehicle_id, token_hash) VALUES ($1, $2, $3, $4)", [randomUUID(), b, await seed.vehicle(b, "OWN001"), sha256Hex(randomUUID())]);

    expect((await catalog().list(a, 10)).find((item) => item.vehicleId === own)?.hasActiveDevice).toBe(false);
  });
});

describe("vincular un vehículo recién creado (sin vehicle_state)", () => {
  it("el código se crea y se canjea, y el catálogo pasa a hasActiveDevice:true", async () => {
    const tenantId = await seed.tenant();
    const { userId } = await seed.user(tenantId);
    const vehicleId = randomUUID();
    await catalog().create({ tenantId, vehicleId, plate: "NEW001", label: null });
    const credentials = createCryptoPairingCredentials();

    const code = await createCreatePairingCode({ codes: createPgPairingCodeRepository(db.pool), credentials, hash: sha256Hex, ttlMinutes: 10 })({
      identity: { userId, tenantId },
      vehicleId,
    });
    const paired = await createPairDevice({ unitOfWork: createPgPairingUnitOfWork(db.pool), credentials, hash: sha256Hex })({ code: code.code });

    expect(paired.response.vehicleId).toBe(vehicleId);
    const states = await db.pool.query("SELECT 1 FROM vehicle_state WHERE vehicle_id = $1", [vehicleId]);
    expect(states.rows).toHaveLength(0);
    expect((await catalog().list(tenantId, 10)).find((item) => item.vehicleId === vehicleId)?.hasActiveDevice).toBe(true);
  });
});

describe("createPgTenantUserReader.listUsers", () => {
  it("lista solo los usuarios del tenant, por nombre, sin el hash de la contraseña", async () => {
    const [a, b] = [await seed.tenant(), await seed.tenant()];
    await seed.user(a, { name: "Zoe", email: `zoe-${randomUUID()}@flota.test` });
    await seed.user(a, { name: "Ana", email: `ana-${randomUUID()}@flota.test` });
    const other = await seed.user(b, { name: "Ajeno" });

    const items = await createPgTenantUserReader(db.pool).listUsers(a, 100);

    expect(items.map((user) => user.name)).toEqual(["Ana", "Zoe"]);
    expect(items.some((user) => user.email === other.email)).toBe(false);
    expect(JSON.stringify(items)).not.toMatch(/scrypt|password/i);
    expect(Object.keys(items[0] ?? {}).sort()).toEqual(["createdAt", "email", "name", "userId"]);
  });

  it("respeta el limit y un tenant sin usuarios da []", async () => {
    const tenantId = await seed.tenant();
    for (const name of ["U1", "U2", "U3"]) await seed.user(tenantId, { name });

    expect(await createPgTenantUserReader(db.pool).listUsers(tenantId, 2)).toHaveLength(2);
    expect(await createPgTenantUserReader(db.pool).listUsers(randomUUID(), 10)).toEqual([]);
  });
});
