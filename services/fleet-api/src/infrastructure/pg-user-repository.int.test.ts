import { randomUUID } from "node:crypto";
import { hashPassword, verifyPassword } from "@fleet/platform";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogin } from "../application/login.js";
import { InvalidCredentialsError } from "../application/errors.js";
import { createIntegrationDatabase, createSeeder, type IntegrationDatabase, type Seeder } from "../testing/integration-db.js";
import { createPgUserRepository } from "./pg-user-repository.js";

// Contra la base real, con el rol de los servicios: la búsqueda por lower(email) debe usar el índice único de la migración 006.
let db: IntegrationDatabase;
let seed: Seeder;

beforeAll(async () => {
  db = await createIntegrationDatabase("fleet-api-user-repository-it");
  seed = createSeeder(db.pool);
});

afterAll(async () => {
  await db?.close();
});

// Parámetros baratos: los de producción cuestan ~150 ms por derivación.
const CHEAP = { N: 1_024, r: 8, p: 1 } as const;

describe("createPgUserRepository.findByEmail", () => {
  it("encuentra al usuario con cualquier combinación de mayúsculas, con su tenant y el nombre del tenant", async () => {
    const tenant = await seed.tenant();
    const { userId } = await seed.user(tenant, { email: `Operador.${randomUUID()}@Norte.Test`, name: "Operador Norte" });
    const repository = createPgUserRepository(db.pool);
    const stored = await db.pool.query<{ email: string }>("SELECT email FROM users WHERE user_id = $1", [userId]);
    const email = stored.rows[0]?.email ?? "";

    for (const variant of [email, email.toLowerCase(), email.toUpperCase()]) {
      const account = await repository.findByEmail(variant);
      expect(account).toMatchObject({ userId, tenantId: tenant, name: "Operador Norte", tenantName: `Flota ${tenant}` });
    }
  });

  it("un correo desconocido es null", async () => {
    await expect(createPgUserRepository(db.pool).findByEmail(`nadie-${randomUUID()}@norte.test`)).resolves.toBeNull();
  });

  it("un correo con forma de inyección SQL se trata como dato", async () => {
    await expect(createPgUserRepository(db.pool).findByEmail("' OR '1'='1")).resolves.toBeNull();
    await expect(createPgUserRepository(db.pool).findByEmail("x@y.test'; DROP TABLE users;--")).resolves.toBeNull();
    await expect(db.pool.query("SELECT 1 FROM users LIMIT 1")).resolves.toBeDefined();
  });

  it("dos tenants distintos: cada correo da su propio tenant", async () => {
    const [a, b] = [await seed.tenant(), await seed.tenant()];
    const [userA, userB] = [await seed.user(a), await seed.user(b)];
    const repository = createPgUserRepository(db.pool);

    expect((await repository.findByEmail(userA.email))?.tenantId).toBe(a);
    expect((await repository.findByEmail(userB.email))?.tenantId).toBe(b);
  });
});

describe("createPgUserRepository.findProfile", () => {
  it("devuelve la sesión del usuario en SU tenant, sin el hash", async () => {
    const tenant = await seed.tenant();
    const { userId, email } = await seed.user(tenant, { name: "Operadora" });

    const session = await createPgUserRepository(db.pool).findProfile({ userId, tenantId: tenant });

    expect(session).toEqual({ user: { userId, email, name: "Operadora" }, tenant: { tenantId: tenant, name: `Flota ${tenant}` } });
    expect(JSON.stringify(session)).not.toContain("scrypt");
  });

  it("con el tenant de otro (o un usuario inexistente) es null: la identidad exige usuario Y tenant", async () => {
    const [a, b] = [await seed.tenant(), await seed.tenant()];
    const { userId } = await seed.user(a);
    const repository = createPgUserRepository(db.pool);

    await expect(repository.findProfile({ userId, tenantId: b })).resolves.toBeNull();
    await expect(repository.findProfile({ userId: randomUUID(), tenantId: a })).resolves.toBeNull();
  });
});

describe("login de punta a punta contra la base real (con scrypt)", () => {
  it("la contraseña correcta entra; la incorrecta y el correo inexistente dan el mismo error", async () => {
    const tenant = await seed.tenant();
    const { email } = await seed.user(tenant, { passwordHash: await hashPassword("la contraseña correcta", CHEAP) });
    const login = createLogin({
      users: createPgUserRepository(db.pool),
      passwords: { verify: verifyPassword },
      dummyPasswordHash: await hashPassword("nadie la conoce", CHEAP),
    });

    await expect(login({ email: email.toUpperCase(), password: "la contraseña correcta" })).resolves.toMatchObject({ identity: { tenantId: tenant } });
    await expect(login({ email, password: "otra" })).rejects.toBeInstanceOf(InvalidCredentialsError);
    await expect(login({ email: `nadie-${randomUUID()}@norte.test`, password: "la contraseña correcta" })).rejects.toBeInstanceOf(InvalidCredentialsError);
  });
});
