import { openDatabaseAsync, type SQLiteDatabase } from "expo-sqlite";
import type {
  MetaKey,
  NewOutboxEntry,
  OutboxEntry,
  OutboxStore,
  QueueCounts,
  SettleInput,
  SettleResult,
} from "../core/store";

const DB_NAME = "fleet-outbox.db";
/** Tablas de diagnóstico acotadas: se conservan las más recientes; el total acumulado vive en `counters`. */
const KEEP_REJECTED = 1_000;
const BUSY_TIMEOUT_MS = 5_000;

/**
 * Migraciones versionadas con `PRAGMA user_version`: `MIGRATIONS[n]` lleva del esquema `n` al `n + 1`.
 * Nunca se edita una migración ya publicada: se agrega otra.
 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE outbox (
    event_id   TEXT PRIMARY KEY NOT NULL,
    payload    TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    status     TEXT NOT NULL CHECK (status IN ('pending', 'in_flight')),
    claimed_at INTEGER,
    attempts   INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX outbox_status_created ON outbox (status, created_at);
  CREATE TABLE rejected (
    event_id    TEXT PRIMARY KEY NOT NULL,
    payload     TEXT NOT NULL,
    reason      TEXT NOT NULL,
    rejected_at INTEGER NOT NULL
  );
  CREATE TABLE dead (
    batch_id  TEXT PRIMARY KEY NOT NULL,
    payload   TEXT NOT NULL,
    reason    TEXT NOT NULL,
    failed_at INTEGER NOT NULL
  );
  CREATE TABLE counters (name TEXT PRIMARY KEY NOT NULL, value INTEGER NOT NULL);
  CREATE TABLE rejected_reasons (reason TEXT PRIMARY KEY NOT NULL, value INTEGER NOT NULL);
  CREATE TABLE meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
  `,
];

type Counter = "sent" | "discarded" | "invalid_local" | "rejected_total" | "dead_total" | "task_failures";

interface OutboxRow {
  event_id: string;
  payload: string;
  created_at: number;
  attempts: number;
}

/**
 * Adaptador de expo-sqlite del puerto `OutboxStore`.
 *
 * Atomicidad: cada método corre en `BEGIN IMMEDIATE ... COMMIT`, así que toma el lock de escritura desde el inicio y
 * dos procesos (UI y tarea en segundo plano headless) no pueden reclamar el mismo lote. Dentro del proceso, un mutex
 * serializa TODOS los métodos para que ninguna escritura ajena caiga dentro de una transacción abierta de la misma
 * conexión. WAL + `busy_timeout` para esperar al otro proceso en vez de fallar.
 */
export class SqliteOutboxStore implements OutboxStore {
  readonly #db: SQLiteDatabase;
  #tail: Promise<unknown> = Promise.resolve();

  private constructor(db: SQLiteDatabase) {
    this.#db = db;
  }

  static async open(name: string = DB_NAME): Promise<SqliteOutboxStore> {
    const db = await openDatabaseAsync(name);
    await db.execAsync(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;`);
    const store = new SqliteOutboxStore(db);
    await store.#migrate();
    return store;
  }

  async #migrate(): Promise<void> {
    await this.#tx(async () => {
      const row = await this.#db.getFirstAsync<{ user_version: number }>("PRAGMA user_version");
      const current = row?.user_version ?? 0;
      for (let v = current; v < MIGRATIONS.length; v++) {
        await this.#db.execAsync(MIGRATIONS[v]!);
        await this.#db.execAsync(`PRAGMA user_version = ${v + 1}`);
      }
    });
  }

  /** Serializa y envuelve en una transacción de escritura inmediata. */
  #tx<T>(fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      await this.#db.execAsync("BEGIN IMMEDIATE");
      try {
        const result = await fn();
        await this.#db.execAsync("COMMIT");
        return result;
      } catch (error) {
        await this.#db.execAsync("ROLLBACK").catch(() => undefined);
        throw error;
      }
    };
    const next = this.#tail.then(run, run);
    this.#tail = next.catch(() => undefined);
    return next;
  }

  /** Lecturas: pasan por el mismo mutex, sin abrir transacción de escritura. */
  #read<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(fn, fn);
    this.#tail = next.catch(() => undefined);
    return next;
  }

  async #bump(name: Counter, by: number): Promise<void> {
    if (by === 0) return;
    await this.#db.runAsync(
      "INSERT INTO counters (name, value) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = value + excluded.value",
      name,
      by,
    );
  }

  enqueue(entry: NewOutboxEntry, cap: number): Promise<{ discarded: number }> {
    return this.#tx(async () => {
      await this.#db.runAsync(
        "INSERT OR IGNORE INTO outbox (event_id, payload, created_at, status, attempts) VALUES (?, ?, ?, 'pending', 0)",
        entry.eventId,
        entry.payload,
        entry.createdAt,
      );
      const total = (await this.#db.getFirstAsync<{ n: number }>("SELECT COUNT(*) AS n FROM outbox"))?.n ?? 0;
      const excess = total - cap;
      if (excess <= 0) return { discarded: 0 };
      // Solo `pending`: lo que está en vuelo lo está usando un request.
      const result = await this.#db.runAsync(
        `DELETE FROM outbox WHERE event_id IN (
           SELECT event_id FROM outbox WHERE status = 'pending' ORDER BY created_at, rowid LIMIT ?
         )`,
        excess,
      );
      await this.#bump("discarded", result.changes);
      return { discarded: result.changes };
    });
  }

  reclaimExpired(nowMs: number, leaseMs: number): Promise<number> {
    return this.#tx(async () => {
      const result = await this.#db.runAsync(
        "UPDATE outbox SET status = 'pending', claimed_at = NULL WHERE status = 'in_flight' AND claimed_at < ?",
        nowMs - leaseMs,
      );
      return result.changes;
    });
  }

  claim(limit: number, maxBytes: number, nowMs: number): Promise<OutboxEntry[]> {
    return this.#tx(async () => {
      const rows = await this.#db.getAllAsync<OutboxRow>(
        "SELECT event_id, payload, created_at, attempts FROM outbox WHERE status = 'pending' ORDER BY created_at, rowid LIMIT ?",
        limit,
      );
      const picked: OutboxRow[] = [];
      let bytes = 0;
      for (const row of rows) {
        if (picked.length > 0 && bytes + row.payload.length > maxBytes) break;
        picked.push(row);
        bytes += row.payload.length;
      }
      for (const row of picked) {
        await this.#db.runAsync("UPDATE outbox SET status = 'in_flight', claimed_at = ? WHERE event_id = ?", nowMs, row.event_id);
      }
      return picked.map((r) => ({ eventId: r.event_id, payload: r.payload, createdAt: r.created_at, attempts: r.attempts }));
    });
  }

  settle(input: SettleInput): Promise<SettleResult> {
    return this.#tx(async () => {
      const inBatch = new Set(input.batch);
      const accepted = new Set(input.accepted.filter((id) => inBatch.has(id)));
      const rejected = input.rejected.filter((r) => inBatch.has(r.eventId) && !accepted.has(r.eventId));
      const rejectedIds = new Set(rejected.map((r) => r.eventId));

      let sent = 0;
      for (const id of accepted) {
        const r = await this.#db.runAsync("DELETE FROM outbox WHERE event_id = ?", id);
        sent += r.changes;
      }
      let rejectedCount = 0;
      for (const r of rejected) {
        const moved = await this.#db.runAsync(
          "INSERT OR REPLACE INTO rejected (event_id, payload, reason, rejected_at) SELECT event_id, payload, ?, ? FROM outbox WHERE event_id = ?",
          r.reason,
          input.nowMs,
          r.eventId,
        );
        if (moved.changes > 0) {
          await this.#db.runAsync("DELETE FROM outbox WHERE event_id = ?", r.eventId);
          await this.#db.runAsync(
            "INSERT INTO rejected_reasons (reason, value) VALUES (?, 1) ON CONFLICT (reason) DO UPDATE SET value = value + 1",
            r.reason,
          );
          rejectedCount++;
        }
      }
      let released = 0;
      for (const id of inBatch) {
        if (accepted.has(id) || rejectedIds.has(id)) continue;
        const r = await this.#db.runAsync(
          "UPDATE outbox SET status = 'pending', claimed_at = NULL, attempts = attempts + 1 WHERE event_id = ? AND status = 'in_flight'",
          id,
        );
        released += r.changes;
      }
      await this.#bump("sent", sent);
      await this.#bump("rejected_total", rejectedCount);
      if (rejectedCount > 0) {
        await this.#db.runAsync(
          "DELETE FROM rejected WHERE rowid NOT IN (SELECT rowid FROM rejected ORDER BY rejected_at DESC, rowid DESC LIMIT ?)",
          KEEP_REJECTED,
        );
      }
      return { sent, rejected: rejectedCount, released };
    });
  }

  release(eventIds: readonly string[]): Promise<void> {
    return this.#tx(async () => {
      for (const id of eventIds) {
        await this.#db.runAsync(
          "UPDATE outbox SET status = 'pending', claimed_at = NULL, attempts = attempts + 1 WHERE event_id = ? AND status = 'in_flight'",
          id,
        );
      }
    });
  }

  markDead(batchId: string, eventIds: readonly string[], reason: string, nowMs: number): Promise<void> {
    return this.#tx(async () => {
      const payloads: string[] = [];
      for (const id of eventIds) {
        const row = await this.#db.getFirstAsync<{ payload: string }>("SELECT payload FROM outbox WHERE event_id = ?", id);
        if (row) {
          payloads.push(row.payload);
          await this.#db.runAsync("DELETE FROM outbox WHERE event_id = ?", id);
        }
      }
      await this.#db.runAsync(
        "INSERT OR REPLACE INTO dead (batch_id, payload, reason, failed_at) VALUES (?, ?, ?, ?)",
        batchId,
        `[${payloads.join(",")}]`,
        reason,
        nowMs,
      );
      // Sin recorte: un 400 pausa el envío, así que `dead` crece como mucho un lote por pausa; recortarlo perdería payloads.
      await this.#bump("dead_total", 1);
    });
  }

  countInvalidLocal(): Promise<void> {
    return this.#tx(() => this.#bump("invalid_local", 1));
  }

  countTaskFailure(): Promise<void> {
    return this.#tx(() => this.#bump("task_failures", 1));
  }

  counts(): Promise<QueueCounts> {
    return this.#read(async () => {
      const status = await this.#db.getAllAsync<{ status: string; n: number }>(
        "SELECT status, COUNT(*) AS n FROM outbox GROUP BY status",
      );
      const counters = await this.#db.getAllAsync<{ name: string; value: number }>("SELECT name, value FROM counters");
      const byStatus = (s: string) => status.find((r) => r.status === s)?.n ?? 0;
      const counter = (name: Counter) => counters.find((c) => c.name === name)?.value ?? 0;
      return {
        pending: byStatus("pending"),
        inFlight: byStatus("in_flight"),
        rejected: counter("rejected_total"),
        dead: counter("dead_total"),
        sent: counter("sent"),
        discarded: counter("discarded"),
        invalidLocal: counter("invalid_local"),
        taskFailures: counter("task_failures"),
      };
    });
  }

  rejectedByReason(): Promise<Record<string, number>> {
    return this.#read(async () => {
      const rows = await this.#db.getAllAsync<{ reason: string; value: number }>("SELECT reason, value FROM rejected_reasons");
      return Object.fromEntries(rows.map((r) => [r.reason, r.value]));
    });
  }

  getMeta(key: MetaKey): Promise<string | null> {
    return this.#read(async () => {
      const row = await this.#db.getFirstAsync<{ value: string }>("SELECT value FROM meta WHERE key = ?", key);
      return row?.value ?? null;
    });
  }

  setMeta(key: MetaKey, value: string | null): Promise<void> {
    return this.#tx(async () => {
      if (value === null) await this.#db.runAsync("DELETE FROM meta WHERE key = ?", key);
      else await this.#db.runAsync("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", key, value);
    });
  }
}
