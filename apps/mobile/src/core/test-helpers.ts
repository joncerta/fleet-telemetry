import type { TelemetryPoint } from "@fleet/contracts";
import { MemoryOutboxStore } from "./memory-store";
import { Outbox } from "./outbox";
import type { OutboxStore } from "./store";
import { SyncEngine, type BatchTransport, type TransportResponse } from "./sync-engine";

export const VEHICLE_ID = "11111111-1111-4111-8111-111111111111";

export function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

export function makePoint(n: number, overrides: Partial<TelemetryPoint> = {}): TelemetryPoint {
  return {
    eventId: uuid(n),
    vehicleId: VEHICLE_ID,
    recordedAt: new Date(1_700_000_000_000 + n * 5_000).toISOString(),
    lon: -74.08,
    lat: 4.6,
    speedMps: 8,
    headingDeg: 90,
    accuracyM: 10,
    altitudeM: null,
    mocked: false,
    lowAccuracy: false,
    ...overrides,
  };
}

export function ack(accepted: string[], rejected: { eventId: string; reason: string; index?: number }[] = []) {
  return {
    schemaVersion: 1,
    accepted,
    rejected: rejected.map((r, i) => ({ index: r.index ?? i, eventId: r.eventId, reason: r.reason })),
    serverTime: "2026-10-05T12:00:00.000Z",
  };
}

export type Scripted = TransportResponse | Error | ((body: { points: unknown[] }) => TransportResponse | Error);

/** Transporte guionado: cada `send` consume el siguiente paso y registra el `eventId` de cada punto enviado. */
export class FakeTransport implements BatchTransport {
  readonly sentBatches: string[][] = [];
  readonly tokens: string[] = [];
  #script: Scripted[];
  constructor(script: Scripted[]) {
    this.#script = [...script];
  }
  push(step: Scripted): void {
    this.#script.push(step);
  }
  send(args: { body: { points: unknown[] }; token: string }): Promise<TransportResponse> {
    this.sentBatches.push(args.body.points.map((p) => (p as TelemetryPoint).eventId));
    this.tokens.push(args.token);
    const step = this.#script.shift();
    if (step === undefined) return Promise.reject(new Error("sin respuesta guionada"));
    const resolved = typeof step === "function" ? step(args.body) : step;
    return resolved instanceof Error ? Promise.reject(resolved) : Promise.resolve(resolved);
  }
}

export const http = (status: number, body: unknown = undefined, retryAfterHeader: string | null = null): TransportResponse => ({
  status,
  body,
  retryAfterHeader,
});

/** Responde 202 aceptando todo lo recibido. */
export const acceptAll = (body: { points: unknown[] }): TransportResponse =>
  http(202, ack(body.points.map((p) => (p as TelemetryPoint).eventId)));

export function setup(options: { script?: Scripted[]; token?: string | null; maxBatchPoints?: number; cap?: number } = {}) {
  return setupWith(new MemoryOutboxStore(), options);
}

/** Igual que `setup`, pero con el almacenamiento que se indique (p. ej. el adaptador SQL contra `node:sqlite`). */
export function setupWith<S extends OutboxStore>(
  store: S,
  options: { script?: Scripted[]; token?: string | null; maxBatchPoints?: number; cap?: number } = {},
) {
  const clock = { now: 1_800_000_000_000 };
  const transport = new FakeTransport(options.script ?? []);
  const discards: number[] = [];
  const outbox = new Outbox({
    store,
    now: () => clock.now,
    ...(options.cap !== undefined && { cap: options.cap }),
    onDiscard: (n) => discards.push(n),
  });
  let batchCounter = 0;
  const engine = new SyncEngine({
    store,
    transport,
    tokens: { getToken: () => Promise.resolve(options.token === undefined ? "fdt_token" : options.token) },
    now: () => clock.now,
    random: () => 0.5,
    newBatchId: () => `batch-${++batchCounter}`,
    ...(options.maxBatchPoints !== undefined && { maxBatchPoints: options.maxBatchPoints }),
  });
  return { clock, store, transport, outbox, engine, discards };
}
