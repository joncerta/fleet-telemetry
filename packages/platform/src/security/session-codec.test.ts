import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSessionCodec, SESSION_SECRET_MIN_BYTES } from "./session-codec.js";

const SECRET = "a".repeat(SESSION_SECRET_MIN_BYTES);
const NOW_MS = Date.parse("2026-10-06T12:00:00.000Z");
const nowSeconds = Math.floor(NOW_MS / 1_000);

const claims = () => ({ userId: randomUUID(), tenantId: randomUUID(), exp: nowSeconds + 3_600 });

/** Firma a mano un payload arbitrario con el secreto de prueba (para fabricar tokens con firma válida pero contenido raro). */
function forge(payload: unknown, secret = SECRET, version = "v1"): string {
  const body = Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload), "utf8").toString("base64url");
  const signed = `${version}.${body}`;
  return `${signed}.${createHmac("sha256", secret).update(signed).digest("base64url")}`;
}

describe("createSessionCodec", () => {
  it("firma y verifica: devuelve los mismos claims", () => {
    const codec = createSessionCodec(SECRET);
    const original = claims();

    expect(codec.verify(codec.sign(original), NOW_MS)).toEqual(original);
  });

  it("el token lleva solo identificadores opacos y la versión, y no cifra: no hay datos personales que filtrar", () => {
    const token = createSessionCodec(SECRET).sign(claims());
    const [version, payload] = token.split(".");

    expect(version).toBe("v1");
    expect(Object.keys(JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8")) as object).sort()).toEqual(["exp", "tenantId", "userId"]);
  });

  it("rechaza un token vencido, y en el instante exacto de `exp` ya no vale", () => {
    const codec = createSessionCodec(SECRET);
    const token = codec.sign({ ...claims(), exp: nowSeconds + 60 });

    expect(codec.verify(token, NOW_MS + 59_999)).toBeDefined();
    expect(codec.verify(token, NOW_MS + 60_000)).toBeUndefined();
    expect(codec.verify(token, NOW_MS + 3_600_000)).toBeUndefined();
  });

  it("rechaza un token firmado con otro secreto", () => {
    const token = createSessionCodec("b".repeat(32)).sign(claims());

    expect(createSessionCodec(SECRET).verify(token, NOW_MS)).toBeUndefined();
  });

  it("rechaza un token cuyo payload fue alterado (cambiar de tenant invalida la firma)", () => {
    const codec = createSessionCodec(SECRET);
    const [version, , signature] = codec.sign(claims()).split(".");
    const tampered = Buffer.from(JSON.stringify({ ...claims(), tenantId: randomUUID() }), "utf8").toString("base64url");

    expect(codec.verify(`${version}.${tampered}.${signature}`, NOW_MS)).toBeUndefined();
  });

  it("rechaza una firma alterada, truncada, vacía o de otro largo", () => {
    const codec = createSessionCodec(SECRET);
    const token = codec.sign(claims());
    const flipped = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;

    for (const candidate of [flipped, token.slice(0, -4), `${token.split(".").slice(0, 2).join(".")}.`, `${token}AAAA`]) {
      expect(codec.verify(candidate, NOW_MS)).toBeUndefined();
    }
  });

  it.each(["", "abc", "v1", "v1.a", "v1.a.b.c", "v2.e30.AAAA", "..", "v1..", "v1.%%%.%%%", `v1.${"a".repeat(2_000)}.b`])("rechaza el token malformado %j sin lanzar", (token) => {
    expect(createSessionCodec(SECRET).verify(token, NOW_MS)).toBeUndefined();
  });

  it("rechaza otra versión aunque la firma sea válida para ese texto", () => {
    const token = forge(claims(), SECRET, "v2");

    expect(createSessionCodec(SECRET).verify(token, NOW_MS)).toBeUndefined();
  });

  it.each([
    ["sin userId", { tenantId: randomUUID(), exp: nowSeconds + 60 }],
    ["userId que no es uuid", { userId: "no-uuid", tenantId: randomUUID(), exp: nowSeconds + 60 }],
    ["exp como texto", { userId: randomUUID(), tenantId: randomUUID(), exp: String(nowSeconds + 60) }],
    ["exp fraccionario", { userId: randomUUID(), tenantId: randomUUID(), exp: nowSeconds + 60.5 }],
    ["exp negativo", { userId: randomUUID(), tenantId: randomUUID(), exp: -1 }],
    ["un arreglo", []],
    ["null", null],
  ])("rechaza claims inválidos con firma válida: %s", (_label, payload) => {
    expect(createSessionCodec(SECRET).verify(forge(payload), NOW_MS)).toBeUndefined();
  });

  it("rechaza un payload que no es JSON, aunque la firma sea válida", () => {
    expect(createSessionCodec(SECRET).verify(forge("esto no es json"), NOW_MS)).toBeUndefined();
  });

  it("sign rechaza claims inválidos en vez de emitir un token que nadie podría verificar", () => {
    const codec = createSessionCodec(SECRET);

    expect(() => codec.sign({ ...claims(), userId: "x" })).toThrow();
    expect(() => codec.sign({ ...claims(), exp: 1.5 })).toThrow();
  });

  it("exige un secreto de al menos 32 bytes, y el mensaje de error no lo incluye", () => {
    const short = "corto-pero-secreto-31-bytes!!!!";

    expect(() => createSessionCodec(short)).toThrow(/al menos 32 bytes/);
    expect(() => createSessionCodec(short)).not.toThrow(/corto-pero/);
    expect(() => createSessionCodec("a".repeat(31))).toThrow();
    expect(() => createSessionCodec("a".repeat(32))).not.toThrow();
  });

  it("el secreto se mide en bytes UTF-8, no en caracteres", () => {
    // 16 caracteres de 2 bytes = 32 bytes.
    expect(() => createSessionCodec("ñ".repeat(16))).not.toThrow();
    expect(() => createSessionCodec("ñ".repeat(15))).toThrow();
  });
});
