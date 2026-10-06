import { randomUUID } from "node:crypto";
import { createLogger, createPool, databaseAdminConfig, defaultMigrationsDir, loadConfig, migrate, sha256Hex } from "@fleet/platform";
import { createTempDatabase, type TempDatabase } from "@fleet/platform/testing";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createAuthenticateDevice } from "../application/authenticate-device.js";
import { createCachedDeviceRepository } from "./cached-device-repository.js";
import { createPgDeviceRepository } from "./pg-device-repository.js";

// Contra TimescaleDB real, sobre una base temporal con las migraciones reales y con el rol de los servicios (fleet_app):
// la consulta de autenticación debe funcionar con sus permisos y con el índice parcial de la migración 002.
const config = loadConfig(z.object(databaseAdminConfig.shape));
const logger = createLogger({ service: "gateway-device-repository-it", level: "error" });
const rolePasswords = { fleet_app: config.FLEET_APP_PASSWORD, fleet_ro: config.FLEET_RO_PASSWORD };

let db: TempDatabase;
let pool: Pool;

beforeAll(async () => {
  db = await createTempDatabase(config.DATABASE_ADMIN_URL);
  await migrate({ adminUrl: db.adminUrl, migrationsDir: defaultMigrationsDir, rolePasswords, logger });
  pool = createPool({ connectionString: db.urlFor("fleet_app", rolePasswords.fleet_app), applicationName: "gateway-device-repository-it", logger, max: 2 });
});

afterAll(async () => {
  await pool?.end();
  await db?.drop();
});

interface Seeded {
  tenantId: string;
  vehicleId: string;
  deviceId: string;
  token: string;
  hash: string;
}

/** Tenant, vehículo y dispositivo aislados con UUID propios (no hay que limpiar entre tests). */
async function seedDevice(): Promise<Seeded> {
  const tenantId = randomUUID();
  const vehicleId = randomUUID();
  const deviceId = randomUUID();
  const token = `fdt_${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "").slice(0, 11)}`;
  const hash = sha256Hex(token);
  await pool.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [tenantId, `Flota ${tenantId}`]);
  await pool.query("INSERT INTO vehicles (id, tenant_id, plate) VALUES ($1, $2, $3)", [vehicleId, tenantId, `T${vehicleId.slice(0, 5).toUpperCase()}`]);
  await pool.query("INSERT INTO devices (id, tenant_id, vehicle_id, token_hash) VALUES ($1, $2, $3, $4)", [deviceId, tenantId, vehicleId, hash]);
  return { tenantId, vehicleId, deviceId, token, hash };
}

const revoke = (deviceId: string) => pool.query("UPDATE devices SET revoked_at = now() WHERE id = $1", [deviceId]);

describe("createPgDeviceRepository contra la base real", () => {
  it("devuelve tenant, dispositivo y vehículo de un dispositivo activo", async () => {
    const seeded = await seedDevice();

    await expect(createPgDeviceRepository(pool).findActiveByTokenHash(seeded.hash)).resolves.toEqual({
      tenantId: seeded.tenantId,
      deviceId: seeded.deviceId,
      vehicleId: seeded.vehicleId,
    });
  });

  it("un hash desconocido es null", async () => {
    await expect(createPgDeviceRepository(pool).findActiveByTokenHash(sha256Hex(randomUUID()))).resolves.toBeNull();
  });

  it("un token revocado es null", async () => {
    const seeded = await seedDevice();
    await revoke(seeded.deviceId);

    await expect(createPgDeviceRepository(pool).findActiveByTokenHash(seeded.hash)).resolves.toBeNull();
  });

  it("rotar el token (revocar y crear) deja entrar solo al nuevo", async () => {
    const old = await seedDevice();
    await revoke(old.deviceId);
    const newToken = `fdt_${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "").slice(0, 11)}`;
    const newDeviceId = randomUUID();
    await pool.query("INSERT INTO devices (id, tenant_id, vehicle_id, token_hash) VALUES ($1, $2, $3, $4)", [newDeviceId, old.tenantId, old.vehicleId, sha256Hex(newToken)]);
    const repository = createPgDeviceRepository(pool);

    await expect(repository.findActiveByTokenHash(old.hash)).resolves.toBeNull();
    await expect(repository.findActiveByTokenHash(sha256Hex(newToken))).resolves.toMatchObject({ deviceId: newDeviceId, vehicleId: old.vehicleId });
  });

  it("la identidad de cada token es la suya: dos dispositivos de tenants distintos no se mezclan", async () => {
    const [a, b] = [await seedDevice(), await seedDevice()];
    const repository = createPgDeviceRepository(pool);

    const [foundA, foundB] = await Promise.all([repository.findActiveByTokenHash(a.hash), repository.findActiveByTokenHash(b.hash)]);

    expect(foundA?.tenantId).toBe(a.tenantId);
    expect(foundB?.tenantId).toBe(b.tenantId);
    expect(foundA?.tenantId).not.toBe(foundB?.tenantId);
  });

  it("un hash con la forma de una inyección SQL se trata como dato, no como SQL", async () => {
    await expect(createPgDeviceRepository(pool).findActiveByTokenHash("' OR '1'='1")).resolves.toBeNull();
  });

  it("el caso de uso de autenticación funciona de punta a punta con el token en claro", async () => {
    const seeded = await seedDevice();
    const authenticate = createAuthenticateDevice({ devices: createPgDeviceRepository(pool), hashToken: sha256Hex });

    await expect(authenticate(seeded.token)).resolves.toMatchObject({ deviceId: seeded.deviceId });
    await revoke(seeded.deviceId);
    await expect(authenticate(seeded.token)).resolves.toBeNull();
  });
});

describe("caché de tokens sobre la base real", () => {
  const cacheOptions = { ttlMs: 30_000, negativeTtlMs: 5_000, maxEntries: 100 };

  it("un token revocado sigue entrando hasta que vence el TTL y después deja de entrar", async () => {
    let now = 0;
    const seeded = await seedDevice();
    const cached = createCachedDeviceRepository(createPgDeviceRepository(pool), { ...cacheOptions, now: () => now });

    await expect(cached.findActiveByTokenHash(seeded.hash)).resolves.toMatchObject({ deviceId: seeded.deviceId });
    await revoke(seeded.deviceId);

    now = 29_999;
    await expect(cached.findActiveByTokenHash(seeded.hash)).resolves.toMatchObject({ deviceId: seeded.deviceId });
    now = 30_000;
    await expect(cached.findActiveByTokenHash(seeded.hash)).resolves.toBeNull();
  });

  it("un token que no existía y se crea después empieza a entrar al vencer el TTL negativo", async () => {
    let now = 0;
    const seeded = await seedDevice();
    await revoke(seeded.deviceId); // para el repositorio es "desconocido" hasta que se reactive
    const cached = createCachedDeviceRepository(createPgDeviceRepository(pool), { ...cacheOptions, now: () => now });

    await expect(cached.findActiveByTokenHash(seeded.hash)).resolves.toBeNull();
    await pool.query("UPDATE devices SET revoked_at = NULL WHERE id = $1", [seeded.deviceId]);

    now = 4_999;
    await expect(cached.findActiveByTokenHash(seeded.hash)).resolves.toBeNull();
    now = 5_000;
    await expect(cached.findActiveByTokenHash(seeded.hash)).resolves.toMatchObject({ deviceId: seeded.deviceId });
  });

  it("un error de la base no se cachea: al volver la base, el token entra", async () => {
    const seeded = await seedDevice();
    const failing = createPool({ connectionString: db.urlFor("fleet_app", "contraseña-incorrecta"), applicationName: "gateway-device-repository-it-bad", logger, max: 1, connectionTimeoutMs: 2_000 });
    let useBad = true;
    const flaky = {
      query: (sql: string, params: unknown[]) => (useBad ? failing : pool).query(sql, params),
    };
    const cached = createCachedDeviceRepository(createPgDeviceRepository(flaky), cacheOptions);

    try {
      await expect(cached.findActiveByTokenHash(seeded.hash)).rejects.toThrow();
      useBad = false;
      await expect(cached.findActiveByTokenHash(seeded.hash)).resolves.toMatchObject({ deviceId: seeded.deviceId });
    } finally {
      await failing.end();
    }
  });
});
