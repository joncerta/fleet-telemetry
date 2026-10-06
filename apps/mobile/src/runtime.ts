import * as Crypto from "expo-crypto";
import type { CredentialsStore } from "./core/credentials";
import { Outbox } from "./core/outbox";
import type { OutboxStore } from "./core/store";
import { SyncEngine } from "./core/sync-engine";
import { createHttpTransport, ingestBaseUrl } from "./infra/http-transport";
import { logEvent } from "./infra/log";
import { secureCredentials } from "./infra/secure-credentials";
import { SqliteOutboxStore } from "./infra/sqlite-store";

export interface Runtime {
  readonly store: OutboxStore;
  readonly outbox: Outbox;
  readonly engine: SyncEngine;
  readonly credentials: CredentialsStore;
}

let instance: Promise<Runtime> | null = null;

/**
 * Composition root de la app. Lo usan por igual la UI y la tarea de ubicación en segundo plano (que corre sin React y,
 * si Android despierta la app, en un proceso nuevo): un solo punto de construcción, sin estado de React.
 * Dentro de un proceso es un singleton; entre procesos, la coordinación la hace SQLite (claim atómico).
 */
export function getRuntime(): Promise<Runtime> {
  instance ??= build().catch((error: unknown) => {
    instance = null; // que el siguiente intento reabra la base
    throw error;
  });
  return instance;
}

async function build(): Promise<Runtime> {
  const store = await SqliteOutboxStore.open();
  const outbox = new Outbox({
    store,
    now: () => Date.now(),
    onDiscard: (count) => logEvent("queue_cap_discard", { count }),
  });
  const engine = new SyncEngine({
    store,
    transport: createHttpTransport({ baseUrl: ingestBaseUrl() }),
    tokens: secureCredentials,
    now: () => Date.now(),
    newBatchId: () => Crypto.randomUUID(),
    onEvent: (event) => {
      if (event.type === "error") logEvent("sync_error", { code: event.code });
      else if (event.type === "batch_acked") logEvent("batch_acked", { sent: event.sent, rejected: event.rejected, released: event.released });
    },
  });
  return { store, outbox, engine, credentials: secureCredentials };
}
