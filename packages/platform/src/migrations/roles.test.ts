import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MigrationError } from "./files.js";
import { FLEET_ROLES, scramSha256Verifier, setRolePasswords, type Queryable } from "./roles.js";

const PASSWORDS = { fleet_app: "pw-app-S3CRET", fleet_ro: "pw-ro-S3CRET" };

interface Call {
  text: string;
  values: unknown[] | undefined;
}

/** Doble de `pg`: `format()` devuelve la sentencia como lo haría el servidor; `onExecute` decide el resultado del ALTER. */
function fakeDb(onExecute: (statement: string, attempt: number) => void = () => undefined) {
  const calls: Call[] = [];
  const attempts = new Map<string, number>();
  const db: Queryable = {
    // Un throw dentro del executor es un rechazo de la promesa, como en pg.
    query: (text, values) => new Promise((resolve) => resolve(handle(text, values))),
  };
  const handle = (text: string, values: unknown[] | undefined): { rows: Record<string, unknown>[] } => {
    calls.push({ text, values });
    if (text.startsWith("SELECT format(")) {
      const [role, verifier] = values ?? [];
      return { rows: [{ statement: `ALTER ROLE "${String(role)}" WITH LOGIN PASSWORD '${String(verifier)}'` }] };
    }
    const attempt = (attempts.get(text) ?? 0) + 1;
    attempts.set(text, attempt);
    onExecute(text, attempt);
    return { rows: [] };
  };
  return { db, calls };
}

async function failureOf(promise: Promise<void>): Promise<MigrationError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof MigrationError) return error;
    throw error;
  }
  throw new Error("setRolePasswords debía fallar");
}

function pgError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

describe("setRolePasswords", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("arma la sentencia en el servidor con format(%I, %L) y los valores como parámetros", async () => {
    const { db, calls } = fakeDb();

    await setRolePasswords(db, PASSWORDS);

    const formatCalls = calls.filter((c) => c.text.startsWith("SELECT format("));
    expect(formatCalls.map((c) => c.values?.[0])).toEqual(["fleet_app", "fleet_ro"]);
    for (const call of formatCalls) expect(call.values).toHaveLength(2);
    for (const call of formatCalls) {
      expect(call.text).toContain("%I");
      expect(call.text).toContain("%L");
      expect(call.text).toContain("$1");
      expect(call.text).toContain("$2");
      // El texto SQL que escribe el cliente nunca contiene la contraseña ni el rol: solo viajan como parámetros.
      expect(call.text).not.toMatch(/S3CRET|fleet_app|fleet_ro/);
    }
  });

  it("envía el verificador SCRAM, nunca la contraseña en claro, ni en parámetros ni en la sentencia", async () => {
    const { db, calls } = fakeDb();

    await setRolePasswords(db, PASSWORDS);

    const formatCalls = calls.filter((c) => c.text.startsWith("SELECT format("));
    for (const call of formatCalls) {
      expect(call.values?.[1]).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*$/);
    }
    // Lo que ejecuta el cliente (parámetros y sentencia devuelta) no contiene ninguna contraseña.
    expect(JSON.stringify(calls)).not.toMatch(/S3CRET/);
  });

  it("rechaza una contraseña no ASCII o vacía sin incluirla en el error", async () => {
    const { db, calls } = fakeDb();

    await expect(setRolePasswords(db, { fleet_app: "contraseña-ñ", fleet_ro: "x" })).rejects.toThrow(/ASCII imprimibles/);
    await expect(setRolePasswords(db, { fleet_app: "", fleet_ro: "x" })).rejects.toThrow(MigrationError);
    expect(calls).toEqual([]);
  });

  it("solo toca los roles de la allowlist y ejecuta el texto que devolvió el servidor", async () => {
    const { db, calls } = fakeDb();

    await setRolePasswords(db, PASSWORDS);

    expect(FLEET_ROLES).toEqual(["fleet_app", "fleet_ro"]);
    const executed = calls.filter((c) => c.text.startsWith("ALTER ROLE"));
    expect(executed.map((c) => c.text.split(" ")[2])).toEqual(['"fleet_app"', '"fleet_ro"']);
  });

  it("si falla, el error no contiene la contraseña, ni la sentencia, ni la causa original", async () => {
    const { db } = fakeDb(() => {
      throw pgError(`syntax error at or near "${PASSWORDS.fleet_app}" in ALTER ROLE ... PASSWORD '${PASSWORDS.fleet_app}'`, "42601");
    });

    const failure = await failureOf(setRolePasswords(db, PASSWORDS));

    expect(failure.message).toBe("No se pudo asignar la contraseña del rol fleet_app (SQLSTATE 42601).");
    expect(failure.cause).toBeUndefined();
    expect(`${failure.message}${failure.stack ?? ""}${JSON.stringify(failure)}`).not.toContain("S3CRET");
  });

  it("si falla el format() tampoco filtra la contraseña", async () => {
    const db: Queryable = { query: () => Promise.reject(pgError("fallo con pw-app-S3CRET", "XX001")) };

    const error = await failureOf(setRolePasswords(db, PASSWORDS));

    expect(error.message).toBe("No se pudo asignar la contraseña del rol fleet_app (SQLSTATE XX001).");
  });

  it("reintenta con backoff cuando otra migración actualizó el mismo rol a la vez", async () => {
    const { db, calls } = fakeDb((statement, attempt) => {
      if (statement.includes('"fleet_app"') && attempt < 3) throw pgError("tuple concurrently updated", "XX000");
    });

    const done = setRolePasswords(db, PASSWORDS);
    await vi.runAllTimersAsync();
    await done;

    expect(calls.filter((c) => c.text.startsWith("ALTER ROLE \"fleet_app\"")).length).toBe(3);
    expect(calls.filter((c) => c.text.startsWith("ALTER ROLE \"fleet_ro\"")).length).toBe(1);
  });

  it("deja de reintentar tras 5 intentos y falla sin filtrar", async () => {
    const { db, calls } = fakeDb(() => {
      throw pgError("tuple concurrently updated", "XX000");
    });

    const result = failureOf(setRolePasswords(db, PASSWORDS));
    await vi.runAllTimersAsync();
    const error = await result;

    expect(error.message).toContain("SQLSTATE XX000");
    expect(calls.filter((c) => c.text.startsWith("ALTER ROLE")).length).toBe(5);
  });

  it("no reintenta errores que no son de concurrencia", async () => {
    const { db, calls } = fakeDb(() => {
      throw pgError('role "fleet_app" does not exist', "42704");
    });

    await expect(setRolePasswords(db, PASSWORDS)).rejects.toThrow("SQLSTATE 42704");

    expect(calls.filter((c) => c.text.startsWith("ALTER ROLE")).length).toBe(1);
  });
});

describe("scramSha256Verifier", () => {
  // Vector de la RFC 7677, sección 3 (usuario "user", contraseña "pencil", sal W22ZaJ0SNY7soEsUEjb6gQ==, i=4096).
  const SALT = Buffer.from("W22ZaJ0SNY7soEsUEjb6gQ==", "base64");
  const NONCE = "rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0";
  const AUTH_MESSAGE = [
    "n=user,r=rOprNGfwEbeRWgbNEkqO",
    `r=${NONCE},s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096`,
    `c=biws,r=${NONCE}`,
  ].join(",");
  const CLIENT_PROOF = "dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=";
  const SERVER_SIGNATURE = "6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=";

  function parts(verifier: string) {
    const match = /^SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):(.+)$/.exec(verifier);
    if (!match) throw new Error("formato de verificador inesperado");
    return { iterations: Number(match[1]), salt: match[2], storedKey: Buffer.from(match[3] ?? "", "base64"), serverKey: Buffer.from(match[4] ?? "", "base64") };
  }

  it("coincide con el intercambio de la RFC 7677: la firma del servidor y la prueba del cliente cuadran", () => {
    const verifier = parts(scramSha256Verifier("pencil", { salt: SALT }));

    expect(verifier.iterations).toBe(4096);
    expect(verifier.salt).toBe("W22ZaJ0SNY7soEsUEjb6gQ==");
    // ServerSignature = HMAC(ServerKey, AuthMessage).
    expect(createHmac("sha256", verifier.serverKey).update(AUTH_MESSAGE).digest("base64")).toBe(SERVER_SIGNATURE);
    // ClientKey = ClientProof XOR HMAC(StoredKey, AuthMessage), y SHA-256(ClientKey) debe ser la StoredKey.
    const signature = createHmac("sha256", verifier.storedKey).update(AUTH_MESSAGE).digest();
    const clientKey = Buffer.from(CLIENT_PROOF, "base64").map((byte, i) => byte ^ (signature[i] ?? 0));
    expect(createHash("sha256").update(clientKey).digest().equals(verifier.storedKey)).toBe(true);
  });

  it("es determinista con la misma sal y distinto con otra contraseña o con otra sal", () => {
    const base = scramSha256Verifier("pencil", { salt: SALT });

    expect(scramSha256Verifier("pencil", { salt: SALT })).toBe(base);
    expect(scramSha256Verifier("pencil2", { salt: SALT })).not.toBe(base);
    expect(scramSha256Verifier("pencil")).not.toBe(scramSha256Verifier("pencil"));
  });

  it("no contiene la contraseña", () => {
    expect(scramSha256Verifier("pw-app-S3CRET")).not.toContain("S3CRET");
  });
});
