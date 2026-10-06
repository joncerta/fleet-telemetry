import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../logger/logger.js";
import { integrationConfig as config } from "../testing/integration-support.js";
import { createTempDatabase, type TempDatabase } from "../testing/temp-database.js";
import { defaultMigrationsDir, migrate } from "./runner.js";

// Reglas de negocio de las migraciones 005 (zonas, estado de vehículo, alertas), 006 (usuarios y códigos de vinculación) y 008 (placa),
// sobre una base temporal con las migraciones reales: claves foráneas compuestas por tenant, CHECK, unicidad del correo sin
// distinguir mayúsculas y la secuencia global. Los datos de cada test llevan UUID propios. El test de ida y vuelta de
// rollback.int.test.ts cubre que los down dejen el esquema como estaba.
const rolePasswords = { fleet_app: config.FLEET_APP_PASSWORD, fleet_ro: config.FLEET_RO_PASSWORD };

let db: TempDatabase;
let admin: Client;
let app: Client;
let readOnly: Client;

async function connect(url: string): Promise<Client> {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

beforeAll(async () => {
  db = await createTempDatabase(config.DATABASE_ADMIN_URL);
  await migrate({
    adminUrl: db.adminUrl,
    migrationsDir: defaultMigrationsDir,
    rolePasswords,
    logger: createLogger({ service: "read-model-rules-it", level: "error" }),
  });
  admin = await connect(db.adminUrl);
  // Los servicios usan fleet_app: las inserciones de los tests también, para comprobar sus permisos.
  app = await connect(db.urlFor("fleet_app", rolePasswords.fleet_app));
  readOnly = await connect(db.urlFor("fleet_ro", rolePasswords.fleet_ro));
});

afterAll(async () => {
  await Promise.all([admin?.end(), app?.end(), readOnly?.end()]);
  await db?.drop();
});

function sqlState(error: unknown): { code?: string; constraint?: string } {
  if (typeof error !== "object" || error === null) return {};
  return {
    ...("code" in error && typeof error.code === "string" && { code: error.code }),
    ...("constraint" in error && typeof error.constraint === "string" && { constraint: error.constraint }),
  };
}

/** Falla con el código SQLSTATE (y la constraint, si se pide) esperados. */
async function expectViolation(promise: Promise<unknown>, code: string, constraint?: string): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e ?? new Error("rechazado sin error"),
  );
  expect(error, "la sentencia debía fallar").toBeDefined();
  expect(sqlState(error)).toMatchObject({ code, ...(constraint !== undefined && { constraint }) });
}

async function insertTenant(): Promise<string> {
  const id = randomUUID();
  await app.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [id, `Flota ${randomUUID()}`]);
  return id;
}

async function insertVehicle(tenantId: string): Promise<string> {
  const id = randomUUID();
  await app.query("INSERT INTO vehicles (id, tenant_id, plate) VALUES ($1, $2, $3)", [id, tenantId, `T${randomUUID().slice(0, 5).toUpperCase()}`]);
  return id;
}

/** Cuadrado de ~600 m en Bogotá, con la longitud primero (regla 13). */
const SQUARE = "POLYGON((-74.075 4.708, -74.069 4.708, -74.069 4.714, -74.075 4.714, -74.075 4.708))";
/** Corbata: un polígono que se cruza a sí mismo, inválido. */
const BOWTIE = "POLYGON((-74.075 4.708, -74.069 4.714, -74.069 4.708, -74.075 4.714, -74.075 4.708))";

function insertZone(tenantId: string, options: { name?: string; kind?: string; wkt?: string } = {}): Promise<string> {
  const id = randomUUID();
  return app
    .query("INSERT INTO zones (zone_id, tenant_id, name, kind, geom) VALUES ($1, $2, $3, $4, ST_GeomFromText($5, 4326))", [
      id,
      tenantId,
      options.name ?? `Zona ${randomUUID()}`,
      options.kind ?? "critical",
      options.wkt ?? SQUARE,
    ])
    .then(() => id);
}

interface StateOptions {
  movement?: string;
  stoppedSince?: string | null;
}

function insertState(tenantId: string, vehicleId: string, options: StateOptions = {}) {
  const movement = options.movement ?? "moving";
  return app.query(
    `INSERT INTO vehicle_state (vehicle_id, tenant_id, geom, recorded_at, received_at, speed_mps, heading_deg, movement, stopped_since, mocked, low_accuracy)
     VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326), now(), now(), 0, NULL, $5, $6, false, false)`,
    [vehicleId, tenantId, -74.0721, 4.711, movement, options.stoppedSince === undefined ? (movement === "stopped" ? new Date().toISOString() : null) : options.stoppedSince],
  );
}

function insertAlert(tenantId: string, vehicleId: string, options: { alertId?: string; type?: string; zoneId?: string | null } = {}) {
  const alertId = options.alertId ?? randomUUID();
  return app
    .query("INSERT INTO alerts (alert_id, tenant_id, vehicle_id, type, zone_id, started_at, raised_at) VALUES ($1, $2, $3, $4, $5, now(), now())", [
      alertId,
      tenantId,
      vehicleId,
      options.type ?? "critical_zone_stop",
      options.zoneId ?? null,
    ])
    .then(() => alertId);
}

describe("zonas (005)", () => {
  it("el tipo solo admite critical, depot y customer", async () => {
    const tenant = await insertTenant();
    for (const kind of ["critical", "depot", "customer"]) await expect(insertZone(tenant, { kind })).resolves.toEqual(expect.any(String));

    await expectViolation(insertZone(tenant, { kind: "parking" }), "23514", "zones_kind_check");
  });

  it("rechaza un polígono inválido (auto-intersección)", async () => {
    await expectViolation(insertZone(await insertTenant(), { wkt: BOWTIE }), "23514", "zones_geom_valid_check");
  });

  it("la geometría es un Polígono en SRID 4326: rechaza un punto y otro SRID", async () => {
    const tenant = await insertTenant();

    await expect(insertZone(tenant, { wkt: "POINT(-74.07 4.71)" })).rejects.toMatchObject({ code: "22023" });
    await expect(
      app.query("INSERT INTO zones (zone_id, tenant_id, name, kind, geom) VALUES ($1, $2, 'otro srid', 'depot', ST_GeomFromText($3, 3857))", [randomUUID(), tenant, SQUARE]),
    ).rejects.toMatchObject({ code: "22023" });
  });

  it("el nombre es único dentro de un tenant, pero se puede repetir en otro", async () => {
    const [a, b] = [await insertTenant(), await insertTenant()];
    await insertZone(a, { name: "Depósito" });

    await expectViolation(insertZone(a, { name: "Depósito" }), "23505", "zones_tenant_name_key");
    await expect(insertZone(b, { name: "Depósito" })).resolves.toEqual(expect.any(String));
  });

  it("exige un tenant existente", async () => {
    await expectViolation(insertZone(randomUUID()), "23503", "zones_tenant_id_fkey");
  });

  it("tiene un índice GIST sobre geom, y ST_Covers por punto lo puede usar", async () => {
    const indexes = await admin.query<{ definition: string }>("SELECT indexdef AS definition FROM pg_indexes WHERE tablename = 'zones'");
    expect(indexes.rows.some((row) => /USING gist \(geom\)/.test(row.definition))).toBe(true);

    const tenant = await insertTenant();
    const inside = await insertZone(tenant);
    const hit = await app.query<{ zone_id: string }>(
      "SELECT zone_id FROM zones WHERE tenant_id = $1 AND ST_Covers(geom, ST_SetSRID(ST_MakePoint($2, $3), 4326))",
      [tenant, -74.072, 4.711],
    );
    expect(hit.rows).toEqual([{ zone_id: inside }]);
    const miss = await app.query("SELECT 1 FROM zones WHERE tenant_id = $1 AND ST_Covers(geom, ST_SetSRID(ST_MakePoint($2, $3), 4326))", [tenant, -75.5, 6.25]);
    expect(miss.rows).toEqual([]);
  });
});

describe("estado de vehículo (005)", () => {
  it("hay una sola fila por vehículo (PK vehicle_id)", async () => {
    const tenant = await insertTenant();
    const vehicle = await insertVehicle(tenant);
    await insertState(tenant, vehicle);

    await expectViolation(insertState(tenant, vehicle), "23505", "vehicle_state_pkey");
  });

  it("la FK compuesta rechaza un estado cuyo vehículo es de otro tenant", async () => {
    const [a, b] = [await insertTenant(), await insertTenant()];
    const vehicleOfA = await insertVehicle(a);

    await expectViolation(insertState(b, vehicleOfA), "23503", "vehicle_state_vehicle_tenant_fkey");
  });

  it("movement solo admite moving y stopped (no_signal se deriva al leer)", async () => {
    const tenant = await insertTenant();

    await expectViolation(insertState(tenant, await insertVehicle(tenant), { movement: "no_signal", stoppedSince: null }), "23514", "vehicle_state_movement_check");
  });

  it("stopped_since tiene valor si y solo si el vehículo está detenido", async () => {
    const tenant = await insertTenant();

    await expectViolation(insertState(tenant, await insertVehicle(tenant), { movement: "stopped", stoppedSince: null }), "23514", "vehicle_state_stopped_since_check");
    await expectViolation(
      insertState(tenant, await insertVehicle(tenant), { movement: "moving", stoppedSince: new Date().toISOString() }),
      "23514",
      "vehicle_state_stopped_since_check",
    );
    await expect(insertState(tenant, await insertVehicle(tenant), { movement: "stopped" })).resolves.toBeDefined();
  });

  it("la geometría es un Punto en SRID 4326", async () => {
    const tenant = await insertTenant();
    const vehicle = await insertVehicle(tenant);

    await expect(
      app.query(
        `INSERT INTO vehicle_state (vehicle_id, tenant_id, geom, recorded_at, received_at, movement, mocked, low_accuracy)
         VALUES ($1, $2, ST_GeomFromText($3, 4326), now(), now(), 'moving', false, false)`,
        [vehicle, tenant, SQUARE],
      ),
    ).rejects.toMatchObject({ code: "22023" });
  });

  it("la secuencia global crece en vehicle_state y alerts, y un UPDATE solo cambia el seq si lo pide con nextval", async () => {
    const tenant = await insertTenant();
    const vehicle = await insertVehicle(tenant);
    await insertState(tenant, vehicle);
    const alertId = await insertAlert(tenant, vehicle);

    const first = await app.query<{ seq: string }>("SELECT seq::text FROM vehicle_state WHERE vehicle_id = $1", [vehicle]);
    const alert = await app.query<{ seq: string }>("SELECT seq::text FROM alerts WHERE alert_id = $1", [alertId]);
    // `seq` llega como string (bigint): se compara como BigInt.
    expect(BigInt(alert.rows[0]?.seq ?? "0")).toBeGreaterThan(BigInt(first.rows[0]?.seq ?? "0"));

    await app.query("UPDATE vehicle_state SET speed_mps = 9 WHERE vehicle_id = $1", [vehicle]);
    const untouched = await app.query<{ seq: string }>("SELECT seq::text FROM vehicle_state WHERE vehicle_id = $1", [vehicle]);
    expect(untouched.rows[0]?.seq).toBe(first.rows[0]?.seq);

    await app.query("UPDATE vehicle_state SET speed_mps = 9, seq = nextval('fleet_event_seq') WHERE vehicle_id = $1", [vehicle]);
    const bumped = await app.query<{ seq: string }>("SELECT seq::text FROM vehicle_state WHERE vehicle_id = $1", [vehicle]);
    expect(BigInt(bumped.rows[0]?.seq ?? "0")).toBeGreaterThan(BigInt(alert.rows[0]?.seq ?? "0"));
  });

  it("fleet_app lee y escribe, fleet_ro solo lee", async () => {
    const tenant = await insertTenant();
    const vehicle = await insertVehicle(tenant);
    await insertState(tenant, vehicle);

    await expect(readOnly.query("SELECT vehicle_id FROM vehicle_state WHERE vehicle_id = $1", [vehicle])).resolves.toMatchObject({ rowCount: 1 });
    await expectViolation(readOnly.query("DELETE FROM vehicle_state WHERE vehicle_id = $1", [vehicle]), "42501");
    await expectViolation(readOnly.query("SELECT nextval('fleet_event_seq')"), "42501");
  });
});

describe("alertas (005)", () => {
  it("el tipo solo admite critical_zone_stop y mocked_location", async () => {
    const tenant = await insertTenant();
    const vehicle = await insertVehicle(tenant);
    await expect(insertAlert(tenant, vehicle, { type: "mocked_location" })).resolves.toEqual(expect.any(String));

    await expectViolation(insertAlert(tenant, vehicle, { type: "speeding" }), "23514", "alerts_type_check");
  });

  it("la FK compuesta rechaza una alerta cuyo vehículo es de otro tenant", async () => {
    const [a, b] = [await insertTenant(), await insertTenant()];
    const vehicleOfA = await insertVehicle(a);

    await expectViolation(insertAlert(b, vehicleOfA), "23503", "alerts_vehicle_tenant_fkey");
  });

  it("la FK compuesta de la zona rechaza la zona de otro tenant, y acepta una zona propia o ninguna (nullable)", async () => {
    const [a, b] = [await insertTenant(), await insertTenant()];
    const vehicleOfA = await insertVehicle(a);
    const zoneOfB = await insertZone(b);
    const zoneOfA = await insertZone(a);

    await expectViolation(insertAlert(a, vehicleOfA, { zoneId: zoneOfB }), "23503", "alerts_zone_tenant_fkey");
    await expect(insertAlert(a, vehicleOfA, { zoneId: zoneOfA })).resolves.toEqual(expect.any(String));
    await expect(insertAlert(a, vehicleOfA, { zoneId: null, type: "mocked_location" })).resolves.toEqual(expect.any(String));
  });

  it("el alert_id es la llave de idempotencia: el mismo id con ON CONFLICT DO NOTHING no duplica", async () => {
    const tenant = await insertTenant();
    const vehicle = await insertVehicle(tenant);
    const alertId = await insertAlert(tenant, vehicle);

    const again = await app.query(
      "INSERT INTO alerts (alert_id, tenant_id, vehicle_id, type, started_at, raised_at) VALUES ($1, $2, $3, 'critical_zone_stop', now(), now()) ON CONFLICT (alert_id) DO NOTHING",
      [alertId, tenant, vehicle],
    );

    expect(again.rowCount).toBe(0);
    await expectViolation(insertAlert(tenant, vehicle, { alertId }), "23505", "alerts_pkey");
  });

  it("no se puede borrar una zona con alertas, ni un vehículo con estado o alertas (no hay borrado en cascada)", async () => {
    const tenant = await insertTenant();
    const vehicle = await insertVehicle(tenant);
    const zone = await insertZone(tenant);
    await insertAlert(tenant, vehicle, { zoneId: zone });
    await insertState(tenant, vehicle);

    await expectViolation(app.query("DELETE FROM zones WHERE zone_id = $1", [zone]), "23503", "alerts_zone_tenant_fkey");
    await expectViolation(app.query("DELETE FROM vehicles WHERE id = $1", [vehicle]), "23503");
  });

  it("las alertas activas por tenant tienen su índice parcial", async () => {
    const indexes = await admin.query<{ definition: string }>("SELECT indexdef AS definition FROM pg_indexes WHERE tablename = 'alerts'");
    expect(indexes.rows.some((row) => /\(tenant_id, raised_at DESC, alert_id DESC\) WHERE \(resolved_at IS NULL\)/.test(row.definition))).toBe(true);
  });
});

describe("placa del vehículo (008)", () => {
  const insertPlate = (tenantId: string, plate: string) =>
    app.query("INSERT INTO vehicles (id, tenant_id, plate) VALUES ($1, $2, $3)", [randomUUID(), tenantId, plate]);

  it("acepta de 1 a 32 caracteres, los mismos que admite el contrato", async () => {
    const tenant = await insertTenant();

    await expect(insertPlate(tenant, "A")).resolves.toBeDefined();
    await expect(insertPlate(tenant, "B".repeat(32))).resolves.toBeDefined();
  });

  it("rechaza una placa vacía o de más de 32 caracteres", async () => {
    const tenant = await insertTenant();

    await expectViolation(insertPlate(tenant, ""), "23514", "vehicles_plate_length_check");
    await expectViolation(insertPlate(tenant, "C".repeat(33)), "23514", "vehicles_plate_length_check");
  });
});

/** Un hash con el formato `scrypt$N$r$p$sal$derivación` (base64url). */
const VALID_HASH = "scrypt$32768$8$3$c2FsdHNhbHRzYWx0c2FsdA$ZGVyaXZlZGtleWRlcml2ZWRrZXlkZXJpdmVka2V5ZGVyaXZlZGtleWRlcml2ZWRrZXlkZXJpdmVka2V5";

async function insertUser(tenantId: string, email = `${randomUUID()}@flota.test`, passwordHash = VALID_HASH): Promise<string> {
  const id = randomUUID();
  await app.query("INSERT INTO users (user_id, tenant_id, email, name, password_hash) VALUES ($1, $2, $3, 'Operador', $4)", [id, tenantId, email, passwordHash]);
  return id;
}

describe("usuarios (006)", () => {
  it("el correo es único sin distinguir mayúsculas, también entre tenants", async () => {
    const [a, b] = [await insertTenant(), await insertTenant()];
    const email = `Operador.${randomUUID()}@Norte.Test`;
    await insertUser(a, email);

    await expectViolation(insertUser(a, email.toLowerCase()), "23505", "users_email_lower_key");
    await expectViolation(insertUser(b, email.toUpperCase()), "23505", "users_email_lower_key");
    await expect(insertUser(b)).resolves.toEqual(expect.any(String));
  });

  it("la búsqueda por lower(email) encuentra el usuario con cualquier combinación de mayúsculas", async () => {
    const tenant = await insertTenant();
    const email = `Buscar.${randomUUID()}@Norte.Test`;
    const userId = await insertUser(tenant, email);

    const found = await app.query<{ user_id: string }>("SELECT user_id FROM users WHERE lower(email) = lower($1)", [email.toUpperCase()]);

    expect(found.rows).toEqual([{ user_id: userId }]);
  });

  it("exige un tenant existente", async () => {
    await expectViolation(insertUser(randomUUID()), "23503", "users_tenant_id_fkey");
  });

  it.each([
    ["una contraseña en claro", "contrasena-en-claro"],
    ["un hash de otro algoritmo", "bcrypt$2b$12$abcdefghijklmnopqrstuv"],
    ["sin parámetros", "scrypt$c2FsdA$ZGVyaXZlZA"],
    ["con un parámetro en cero", "scrypt$0$8$3$c2FsdA$ZGVyaXZlZA"],
    ["con base64 estándar (+ y /)", "scrypt$32768$8$3$c2Fs+A$ZGVy/XZl"],
    ["vacío", ""],
  ])("rechaza %s como password_hash", async (_label, hash) => {
    await expectViolation(insertUser(await insertTenant(), undefined, hash), "23514", "users_password_hash_format");
  });

  it("acepta el formato scrypt$N$r$p$sal$derivación", async () => {
    await expect(insertUser(await insertTenant(), undefined, VALID_HASH)).resolves.toEqual(expect.any(String));
  });
});

const codeHash = () => randomUUID().replaceAll("-", "").repeat(2);

function insertCode(tenantId: string, vehicleId: string, createdBy: string, hash = codeHash()) {
  return app.query("INSERT INTO device_pairing_codes (code_hash, tenant_id, vehicle_id, created_by, expires_at) VALUES ($1, $2, $3, $4, now() + interval '15 minutes')", [
    hash,
    tenantId,
    vehicleId,
    createdBy,
  ]);
}

describe("códigos de vinculación (006)", () => {
  it("guarda el hash del código y su vencimiento; used_at empieza vacío", async () => {
    const tenant = await insertTenant();
    const [vehicle, user] = [await insertVehicle(tenant), await insertUser(tenant)];
    const hash = codeHash();
    await insertCode(tenant, vehicle, user, hash);

    const row = await app.query<{ used_at: Date | null; expires_at: Date }>("SELECT used_at, expires_at FROM device_pairing_codes WHERE code_hash = $1", [hash]);

    expect(row.rows[0]?.used_at).toBeNull();
    expect(row.rows[0]?.expires_at.getTime()).toBeGreaterThan(Date.now());
  });

  it("la FK compuesta rechaza un código cuyo vehículo es de otro tenant", async () => {
    const [a, b] = [await insertTenant(), await insertTenant()];
    const [vehicleOfA, userOfB] = [await insertVehicle(a), await insertUser(b)];

    await expectViolation(insertCode(b, vehicleOfA, userOfB), "23503", "device_pairing_codes_vehicle_tenant_fkey");
  });

  it("la FK compuesta rechaza un código creado por un usuario de otro tenant", async () => {
    const [a, b] = [await insertTenant(), await insertTenant()];
    const [vehicleOfA, userOfB] = [await insertVehicle(a), await insertUser(b)];

    await expectViolation(insertCode(a, vehicleOfA, userOfB), "23503", "device_pairing_codes_created_by_tenant_fkey");
  });

  it("created_by debe existir en users", async () => {
    const tenant = await insertTenant();

    await expectViolation(insertCode(tenant, await insertVehicle(tenant), randomUUID()), "23503", "device_pairing_codes_created_by_tenant_fkey");
  });

  it("el code_hash es un sha256 en hexadecimal minúscula y es único", async () => {
    const tenant = await insertTenant();
    const [vehicle, user] = [await insertVehicle(tenant), await insertUser(tenant)];

    await expectViolation(insertCode(tenant, vehicle, user, "K7M2QX9P"), "23514", "device_pairing_codes_code_hash_format");
    await expectViolation(insertCode(tenant, vehicle, user, codeHash().toUpperCase()), "23514", "device_pairing_codes_code_hash_format");

    const hash = codeHash();
    await insertCode(tenant, vehicle, user, hash);
    await expectViolation(insertCode(tenant, vehicle, user, hash), "23505", "device_pairing_codes_pkey");
  });

  it("el canje de un solo uso se hace con un UPDATE condicional: el segundo intento no actualiza nada", async () => {
    const tenant = await insertTenant();
    const [vehicle, user] = [await insertVehicle(tenant), await insertUser(tenant)];
    const hash = codeHash();
    await insertCode(tenant, vehicle, user, hash);
    const redeem = () =>
      app.query("UPDATE device_pairing_codes SET used_at = now() WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING vehicle_id", [hash]);

    expect((await redeem()).rowCount).toBe(1);
    expect((await redeem()).rowCount).toBe(0);
  });
});
