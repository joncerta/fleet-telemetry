import { describe, expect, it, vi } from "vitest";
import { assertLocalDatabase, LocalOnlyError, type MarkQueryable } from "./local-only.js";

const local = "postgres://fleet_app:secreto@127.0.0.1:5432/fleet";

function dbWithMark(value: string | null) {
  const query = vi.fn().mockResolvedValue({ rows: [{ value }] });
  const db: MarkQueryable = { query };
  return { db, query };
}

const check = (url: string, db: MarkQueryable, variable = "DATABASE_URL") =>
  assertLocalDatabase({ url, variable, command: "db:seed", db });

describe("assertLocalDatabase", () => {
  it("acepta un host local con la marca fleet.environment=local", async () => {
    const { db, query } = dbWithMark("local");

    await expect(check(local, db)).resolves.toBeUndefined();

    expect(query).toHaveBeenCalledWith(expect.stringContaining("current_setting"), ["fleet.environment"]);
  });

  it("rechaza un host remoto sin siquiera consultar la base", async () => {
    const { db, query } = dbWithMark("local");

    const result = check("postgres://fleet_app:secreto@prod-db.example.com:5432/fleet", db);

    await expect(result).rejects.toBeInstanceOf(LocalOnlyError);
    await expect(result).rejects.toThrow(/db:seed solo corre contra una base local.*DATABASE_URL.*prod-db\.example\.com/s);
    expect(query).not.toHaveBeenCalled();
  });

  it("rechaza un host local cuyo servidor no tiene la marca (túnel hacia una base remota)", async () => {
    await expect(check(local, dbWithMark(null).db)).rejects.toThrow(/sin marca/);
    await expect(check(local, dbWithMark("production").db)).rejects.toThrow(/production/);
  });

  it("nombra la variable que se usó y no filtra la contraseña de la URL", async () => {
    const error: unknown = await check("postgres://fleet:secreto@10.0.0.5:5432/fleet", dbWithMark("local").db, "DATABASE_ADMIN_URL").catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(LocalOnlyError);
    expect(error).toHaveProperty("message", expect.stringContaining("DATABASE_ADMIN_URL") as string);
    expect(error).toHaveProperty("message", expect.not.stringContaining("secreto") as string);
  });

  it("rechaza ?host= en la URL (cambiaría el host real)", async () => {
    await expect(check(`${local}?host=prod-db.example.com`, dbWithMark("local").db)).rejects.toBeInstanceOf(LocalOnlyError);
  });

  it("propaga un fallo de la base (no lo disfraza de guarda)", async () => {
    const db: MarkQueryable = { query: vi.fn().mockRejectedValue(new Error("connection refused")) };

    await expect(check(local, db)).rejects.toThrow("connection refused");
  });
});
