import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ack, acceptAll, http, makePoint, setupWith, uuid } from "../core/test-helpers";
import { SqliteOutboxStore } from "./sqlite-store";

// El adaptador real de expo-sqlite se ejercita contra SQLite de verdad (node:sqlite) con un shim de la API async de
// expo-sqlite. Verifica el SQL, las transacciones, las migraciones y WAL; no el módulo nativo.
let dir = "";

vi.mock("expo-sqlite", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  type Param = string | number | null;
  class Shim {
    readonly db: InstanceType<typeof DatabaseSync>;
    constructor(path: string) {
      this.db = new DatabaseSync(path);
      ((globalThis as Record<string, unknown>)["__fleetDbs"] as InstanceType<typeof DatabaseSync>[] | undefined)?.push(this.db);
    }
    execAsync(sql: string): Promise<void> {
      this.db.exec(sql);
      return Promise.resolve();
    }
    runAsync(sql: string, ...params: Param[]): Promise<{ changes: number; lastInsertRowId: number }> {
      const r = this.db.prepare(sql).run(...params);
      return Promise.resolve({ changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) });
    }
    getAllAsync<T>(sql: string, ...params: Param[]): Promise<T[]> {
      return Promise.resolve(this.db.prepare(sql).all(...params) as T[]);
    }
    getFirstAsync<T>(sql: string, ...params: Param[]): Promise<T | null> {
      return Promise.resolve((this.db.prepare(sql).get(...params) as T | undefined) ?? null);
    }
  }
  return { openDatabaseAsync: (name: string) => Promise.resolve(new Shim(`${process.env["FLEET_TEST_DB_DIR"]}/${name}`)) };
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fleet-sqlite-"));
  process.env["FLEET_TEST_DB_DIR"] = dir;
  (globalThis as Record<string, unknown>)["__fleetDbs"] = [];
});
afterEach(() => {
  // Windows no borra archivos con la conexión abierta.
  for (const db of ((globalThis as Record<string, unknown>)["__fleetDbs"] as { close(): void }[]) ?? []) db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function enqueue(ctx: ReturnType<typeof setupWith>, n: number, from = 1): Promise<string[]> {
  const ids: string[] = [];
  for (let i = from; i < from + n; i++) {
    ctx.clock.now += 1;
    await ctx.outbox.enqueue(makePoint(i));
    ids.push(uuid(i));
  }
  return ids;
}

describe("SqliteOutboxStore", () => {
  it("migra el esquema (user_version) y activa WAL", async () => {
    const store = await SqliteOutboxStore.open("a.db");
    expect(await store.counts()).toEqual({ pending: 0, inFlight: 0, rejected: 0, dead: 0, sent: 0, discarded: 0, invalidLocal: 0 });
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(join(dir, "a.db"));
    expect(raw.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    expect(raw.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    raw.close();
    // Reabrir no repite la migración.
    await SqliteOutboxStore.open("a.db");
  });

  it("ACK parcial: borra lo aceptado, mueve lo rechazado, deja lo ausente en pending", async () => {
    const ctx = setupWith(await SqliteOutboxStore.open("b.db"));
    const [a, b, c] = await enqueue(ctx, 3);
    ctx.transport.push(http(202, ack([a!], [{ eventId: b!, reason: "invalid_schema" }])));

    await ctx.engine.drain();

    expect(await ctx.store.counts()).toMatchObject({ pending: 1, inFlight: 0, sent: 1, rejected: 1 });
    expect(await ctx.store.rejectedByReason()).toEqual({ invalid_schema: 1 });
    const next = await ctx.store.claim(10, 1e6, ctx.clock.now);
    expect(next.map((e) => e.eventId)).toEqual([c]);
  });

  it("los pendientes sobreviven a matar la app (reabrir la base) y se envían con los mismos eventId", async () => {
    const first = setupWith(await SqliteOutboxStore.open("c.db"));
    const ids = await enqueue(first, 5);

    const second = setupWith(await SqliteOutboxStore.open("c.db"), { script: [acceptAll] });
    expect((await second.store.counts()).pending).toBe(5);
    await second.engine.drain();
    expect(second.transport.sentBatches).toEqual([ids]);
    expect((await second.store.counts()).pending).toBe(0);
  });

  it("un lote in_flight de un proceso muerto vuelve a pending tras el lease", async () => {
    const ctx = setupWith(await SqliteOutboxStore.open("d.db"), { script: [acceptAll] });
    await enqueue(ctx, 3);
    await ctx.store.claim(200, 1e6, ctx.clock.now);
    expect(await ctx.store.counts()).toMatchObject({ pending: 0, inFlight: 3 });

    ctx.clock.now += 61_000;
    const result = await ctx.engine.drain();
    expect(result).toMatchObject({ outcome: "drained", sent: 3 });
  });

  it("dos conexiones (UI y tarea en segundo plano) no reclaman los mismos puntos", async () => {
    const a = await SqliteOutboxStore.open("e.db");
    const b = await SqliteOutboxStore.open("e.db");
    const ctx = setupWith(a);
    await enqueue(ctx, 10);
    // node:sqlite es síncrono y no puede esperar un lock ajeno: se prueba que el reclamo vive en la BASE (la segunda
    // conexión ve lo que reclamó la primera), no en memoria. La exclusión real entre procesos la da BEGIN IMMEDIATE.
    const x = await a.claim(6, 1e6, ctx.clock.now);
    const y = await b.claim(6, 1e6, ctx.clock.now);
    const ids = [...x, ...y].map((e) => e.eventId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(10);
  });

  it("el tope descarta los pending más viejos y los cuenta", async () => {
    const ctx = setupWith(await SqliteOutboxStore.open("f.db"), { cap: 5 });
    await enqueue(ctx, 8);
    expect(await ctx.store.counts()).toMatchObject({ pending: 5, discarded: 3 });
    const kept = await ctx.store.claim(10, 1e6, ctx.clock.now);
    expect(kept.map((e) => e.eventId)).toEqual([4, 5, 6, 7, 8].map(uuid));
    expect(ctx.discards).toEqual([1, 1, 1]);
  });

  it("claim respeta el orden de captura y el tope de bytes", async () => {
    const ctx = setupWith(await SqliteOutboxStore.open("g.db"));
    const ids = await enqueue(ctx, 6);
    const size = JSON.stringify(makePoint(1)).length;
    const first = await ctx.store.claim(200, size * 2 + 1, ctx.clock.now);
    expect(first.map((e) => e.eventId)).toEqual(ids.slice(0, 2));
    const rest = await ctx.store.claim(200, 1e6, ctx.clock.now);
    expect(rest.map((e) => e.eventId)).toEqual(ids.slice(2));
  });

  it("fallos transitorios no borran nada y 400 va a dead; el contador de rechazados se conserva", async () => {
    const ctx = setupWith(await SqliteOutboxStore.open("h.db"));
    await enqueue(ctx, 2);
    ctx.transport.push(http(503, undefined, "1"));
    await ctx.engine.drain();
    expect(await ctx.store.counts()).toMatchObject({ pending: 2, inFlight: 0, dead: 0 });

    ctx.transport.push(http(400, { error: { code: "invalid_envelope", message: "x" } }));
    await ctx.engine.drain({ force: true });
    expect(await ctx.store.counts()).toMatchObject({ pending: 0, dead: 1 });
  });

  it("no guarda dos veces el mismo eventId", async () => {
    const ctx = setupWith(await SqliteOutboxStore.open("i.db"));
    await ctx.outbox.enqueue(makePoint(1));
    await ctx.outbox.enqueue(makePoint(1));
    expect((await ctx.store.counts()).pending).toBe(1);
  });

  it("metadatos: guardar, leer y borrar", async () => {
    const store = await SqliteOutboxStore.open("j.db");
    await store.setMeta("lastError", "http_500");
    expect(await store.getMeta("lastError")).toBe("http_500");
    await store.setMeta("lastError", null);
    expect(await store.getMeta("lastError")).toBeNull();
  });
});
