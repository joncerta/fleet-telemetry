import { describe, expect, it } from "vitest";
import { MigrationError } from "./files.js";
import { assertLocalDatabaseHost, assertLocalEnvironmentMark, assertNoConnectionOptions, LOCAL_DATABASE_HOSTS } from "./local-guard.js";

describe("assertLocalDatabaseHost", () => {
  it("la allowlist es exactamente la local", () => {
    expect(LOCAL_DATABASE_HOSTS).toEqual(["127.0.0.1", "localhost", "::1", "timescaledb"]);
  });

  it.each([
    "postgres://fleet:pw@127.0.0.1:5432/fleet",
    "postgres://fleet:pw@localhost:5432/fleet",
    "postgresql://fleet:pw@LOCALHOST/fleet",
    "postgres://fleet:pw@[::1]:5432/fleet",
    "postgres://fleet:pw@timescaledb:5432/fleet",
    "postgres://fleet:pw@127.0.0.1:5432/fleet?sslmode=disable",
  ])("acepta %s", (url) => {
    expect(() => assertLocalDatabaseHost(url)).not.toThrow();
  });

  it.each([
    ["un host remoto", "postgres://fleet:pw@db.prod.example.com:5432/fleet"],
    ["una IP privada", "postgres://fleet:pw@10.0.3.7:5432/fleet"],
    ["un RDS", "postgres://fleet:pw@fleet.abc123.us-east-1.rds.amazonaws.com/fleet"],
    ["un subdominio que empieza como uno local", "postgres://fleet:pw@localhost.evil.com/fleet"],
    ["localhost solo en el usuario", "postgres://localhost:pw@evil.com/fleet"],
    ["una lista de hosts", "postgres://fleet:pw@127.0.0.1,db.prod.example.com/fleet"],
    ["0.0.0.0", "postgres://fleet:pw@0.0.0.0:5432/fleet"],
  ])("rechaza %s", (_caso, url) => {
    expect(() => assertLocalDatabaseHost(url)).toThrow(MigrationError);
    expect(() => assertLocalDatabaseHost(url)).toThrow(/solo corre contra una base local/);
  });

  it.each(["host", "hostaddr", "service"])("rechaza el parámetro ?%s=, que cambiaría el host real de la conexión", (param) => {
    const url = `postgres://fleet:pw@localhost:5432/fleet?${param}=db.prod.example.com`;

    expect(() => assertLocalDatabaseHost(url)).toThrow(new RegExp(`parámetro "${param}"`));
  });

  it("rechaza ?options=, con el que un túnel a una base remota pasaría la guarda de la marca local", () => {
    const url = "postgres://fleet:pw@localhost:5432/fleet?options=-c%20fleet.environment%3Dlocal";

    expect(() => assertLocalDatabaseHost(url)).toThrow(MigrationError);
    expect(() => assertLocalDatabaseHost(url)).toThrow(/options/);
  });

  it("rechaza una URL inválida", () => {
    expect(() => assertLocalDatabaseHost("no es una url")).toThrow(/no es una URL válida/);
  });

  it("el error nombra el host pero nunca la contraseña ni el usuario", () => {
    let message = "";
    try {
      assertLocalDatabaseHost("postgres://admin-user:S3CRET-pw@db.prod.example.com/fleet");
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }

    expect(message).toContain("db.prod.example.com");
    expect(message).not.toMatch(/S3CRET|admin-user/);
  });
});

describe("assertLocalEnvironmentMark", () => {
  it("acepta solo la marca local", () => {
    expect(() => assertLocalEnvironmentMark("local")).not.toThrow();
  });

  it.each([
    ["sin marca (null)", null],
    ["sin marca (undefined)", undefined],
    ["marca vacía", ""],
    ["otro entorno", "remote"],
    ["producción", "production"],
    ["distinta capitalización", "Local"],
    ["con espacios", " local"],
  ])("rechaza %s", (_caso, value) => {
    expect(() => assertLocalEnvironmentMark(value)).toThrow(MigrationError);
    expect(() => assertLocalEnvironmentMark(value)).toThrow(/marcada como local/);
  });

  it("el mensaje dice cómo resolverlo: un contenedor anterior a la marca no la tiene", () => {
    expect(() => assertLocalEnvironmentMark(null)).toThrow(/recrea el contenedor con `docker compose up -d --wait`/);
  });

  it("el mensaje dice que la base no está marcada como local y qué valor tiene", () => {
    expect(() => assertLocalEnvironmentMark("remote")).toThrow(/fleet\.environment=local.*marcada como "remote"/s);
    expect(() => assertLocalEnvironmentMark(null)).toThrow(/sin marca/);
  });
});

describe("assertNoConnectionOptions", () => {
  it.each([
    "postgres://fleet:pw@localhost:5432/fleet",
    "postgres://fleet:pw@localhost:5432/fleet?sslmode=disable",
    "postgres://fleet:pw@localhost:5432/fleet?application_name=options",
    "postgres://fleet:pw@localhost:5432/fleet?Options=x",
    "postgres://fleet:pw@localhost/fleet",
  ])("acepta %s", (url) => {
    expect(() => assertNoConnectionOptions(url)).not.toThrow();
  });

  it.each([
    ["con la marca local", "postgres://fleet:pw@localhost:5432/fleet?options=-c%20fleet.environment%3Dlocal"],
    ["con un timeout", "postgres://fleet:pw@localhost:5432/fleet?options=-c%20lock_timeout%3D0"],
    ["vacío", "postgres://fleet:pw@localhost:5432/fleet?options="],
    ["con otro parámetro antes", "postgres://fleet:pw@localhost:5432/fleet?sslmode=disable&options=-c%20timezone%3Dx"],
    ["con la clave codificada", "postgres://fleet:pw@localhost:5432/fleet?%6Fptions=-c%20timezone%3Dx"],
    ["sin host", "postgres:///fleet?options=-c%20timezone%3Dx"],
    ["con espacios sin codificar", "postgres://fleet:pw@localhost:5432/fleet?options=-c timezone=x"],
  ])("rechaza ?options= %s", (_caso, url) => {
    expect(() => assertNoConnectionOptions(url)).toThrow(MigrationError);
    expect(() => assertNoConnectionOptions(url)).toThrow(/options.*fija sus propios parámetros/s);
  });

  it("el error no cita las credenciales ni el valor de options", () => {
    let message = "";
    try {
      assertNoConnectionOptions("postgres://admin-user:S3CRET-pw@localhost/fleet?options=-c%20secreto%3D1");
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }

    expect(message).not.toMatch(/S3CRET|admin-user|secreto/);
  });
});
