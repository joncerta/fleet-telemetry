import type { MetaKey, NewOutboxEntry, OutboxEntry, OutboxStore, QueueCounts, SettleInput, SettleResult } from "./store";

interface Row {
  eventId: string;
  payload: string;
  createdAt: number;
  status: "pending" | "in_flight";
  claimedAt: number | null;
  attempts: number;
  seq: number;
}

/**
 * Implementación en memoria del puerto, para pruebas y para ejercitar el núcleo sin dispositivo. Cada método es
 * síncrono por dentro (sin `await` a medias), así que es atómico igual que una transacción de SQLite.
 */
export class MemoryOutboxStore implements OutboxStore {
  readonly rows = new Map<string, Row>();
  readonly rejectedRows: { eventId: string; reason: string; rejectedAt: number }[] = [];
  readonly deadRows: { batchId: string; payload: string; reason: string; failedAt: number }[] = [];
  readonly #meta = new Map<MetaKey, string>();
  #seq = 0;
  #sent = 0;
  #discarded = 0;
  #invalidLocal = 0;

  enqueue(entry: NewOutboxEntry, cap: number): Promise<{ discarded: number }> {
    if (!this.rows.has(entry.eventId)) {
      this.rows.set(entry.eventId, { ...entry, status: "pending", claimedAt: null, attempts: 0, seq: this.#seq++ });
    }
    let discarded = 0;
    const excess = this.rows.size - cap;
    if (excess > 0) {
      const oldest = [...this.rows.values()]
        .filter((r) => r.status === "pending")
        .sort((a, b) => a.createdAt - b.createdAt || a.seq - b.seq)
        .slice(0, excess);
      for (const r of oldest) this.rows.delete(r.eventId);
      discarded = oldest.length;
      this.#discarded += discarded;
    }
    return Promise.resolve({ discarded });
  }

  reclaimExpired(nowMs: number, leaseMs: number): Promise<number> {
    let n = 0;
    for (const r of this.rows.values()) {
      if (r.status === "in_flight" && r.claimedAt !== null && r.claimedAt < nowMs - leaseMs) {
        r.status = "pending";
        r.claimedAt = null;
        n++;
      }
    }
    return Promise.resolve(n);
  }

  claim(limit: number, maxBytes: number, nowMs: number): Promise<OutboxEntry[]> {
    const candidates = [...this.rows.values()]
      .filter((r) => r.status === "pending")
      .sort((a, b) => a.createdAt - b.createdAt || a.seq - b.seq)
      .slice(0, limit);
    const picked: Row[] = [];
    let bytes = 0;
    for (const r of candidates) {
      const size = r.payload.length;
      if (picked.length > 0 && bytes + size > maxBytes) break;
      picked.push(r);
      bytes += size;
    }
    for (const r of picked) {
      r.status = "in_flight";
      r.claimedAt = nowMs;
    }
    return Promise.resolve(
      picked.map((r) => ({ eventId: r.eventId, payload: r.payload, createdAt: r.createdAt, attempts: r.attempts })),
    );
  }

  settle(input: SettleInput): Promise<SettleResult> {
    const inBatch = new Set(input.batch);
    const accepted = new Set(input.accepted.filter((id) => inBatch.has(id)));
    const rejected = input.rejected.filter((r) => inBatch.has(r.eventId) && !accepted.has(r.eventId));
    const rejectedIds = new Set(rejected.map((r) => r.eventId));
    for (const id of accepted) this.rows.delete(id);
    for (const r of rejected) {
      if (this.rows.delete(r.eventId)) {
        this.rejectedRows.push({ eventId: r.eventId, reason: r.reason, rejectedAt: input.nowMs });
      }
    }
    let released = 0;
    for (const id of inBatch) {
      if (accepted.has(id) || rejectedIds.has(id)) continue;
      const row = this.rows.get(id);
      if (row?.status === "in_flight") {
        row.status = "pending";
        row.claimedAt = null;
        row.attempts++;
        released++;
      }
    }
    this.#sent += accepted.size;
    return Promise.resolve({ sent: accepted.size, rejected: rejected.length, released });
  }

  release(eventIds: readonly string[]): Promise<void> {
    for (const id of eventIds) {
      const row = this.rows.get(id);
      if (row?.status === "in_flight") {
        row.status = "pending";
        row.claimedAt = null;
        row.attempts++;
      }
    }
    return Promise.resolve();
  }

  markDead(batchId: string, eventIds: readonly string[], reason: string, nowMs: number): Promise<void> {
    const payloads: string[] = [];
    for (const id of eventIds) {
      const row = this.rows.get(id);
      if (row) {
        payloads.push(row.payload);
        this.rows.delete(id);
      }
    }
    this.deadRows.push({ batchId, payload: `[${payloads.join(",")}]`, reason, failedAt: nowMs });
    return Promise.resolve();
  }

  countInvalidLocal(): Promise<void> {
    this.#invalidLocal++;
    return Promise.resolve();
  }

  counts(): Promise<QueueCounts> {
    const all = [...this.rows.values()];
    return Promise.resolve({
      pending: all.filter((r) => r.status === "pending").length,
      inFlight: all.filter((r) => r.status === "in_flight").length,
      rejected: this.rejectedRows.length,
      dead: this.deadRows.length,
      sent: this.#sent,
      discarded: this.#discarded,
      invalidLocal: this.#invalidLocal,
    });
  }

  rejectedByReason(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const r of this.rejectedRows) out[r.reason] = (out[r.reason] ?? 0) + 1;
    return Promise.resolve(out);
  }

  getMeta(key: MetaKey): Promise<string | null> {
    return Promise.resolve(this.#meta.get(key) ?? null);
  }

  setMeta(key: MetaKey, value: string | null): Promise<void> {
    if (value === null) this.#meta.delete(key);
    else this.#meta.set(key, value);
    return Promise.resolve();
  }
}
