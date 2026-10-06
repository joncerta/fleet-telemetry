import { telemetryDlqMessageSchema, type TelemetryRawEvent, type VehicleStateEvent } from "@fleet/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeadLetterPublicationError, FleetEventPublicationError, PersistenceUnavailableError, UnsupportedSchemaVersionError } from "./errors.js";
import {
  createPersistTelemetryBatch,
  type IncomingMessage,
  type PersistReport,
  type PersistTelemetryBatch,
} from "./persist-telemetry-batch.js";
import type { BackoffPolicy } from "../domain/retry-policy.js";
import type { BatchCheckpoint, DeadLetterEntry, DeadLetterPublisher, InsertOutcome, ProcessorLogger, Sleeper, TelemetryRepository } from "./ports.js";
import type { FleetStateUpdater, FleetTelemetry, FleetUpdate } from "./update-fleet-state.js";

const TENANT = "9d7e1b34-2a6c-4f08-b5d3-6e4a8c1f0b92";
const DEVICE = "5b8a3f6c-1e9d-4a27-8c40-7f2e6d1b9a35";
const VEHICLE = "a1c4e9d2-7b3f-4c58-8e16-0d9f2b6a4c71";
const VEHICLE_2 = "b2d5f0e3-8c4a-4d69-9f27-1e0a3c7b5d82";
const NOW = new Date("2026-03-14T20:05:00.000Z");

const uuidFor = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const rawEvent = (n: number, pointOverrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: 1,
  tenantId: TENANT,
  deviceId: DEVICE,
  receivedAt: "2026-03-14T20:00:00.000Z",
  point: {
    eventId: uuidFor(n),
    vehicleId: VEHICLE,
    recordedAt: "2026-03-14T19:59:30.000Z",
    lon: -75.5636,
    lat: 6.2518,
    speedMps: 12.5,
    headingDeg: 90,
    accuracyM: 8,
    mocked: false,
    lowAccuracy: false,
    ...pointOverrides,
  },
});

/** Mensaje de Kafka con el evento `n`; el offset es `100 + n` para distinguirlo del id. */
const eventMessage = (n: number, pointOverrides: Record<string, unknown> = {}, correlationId = `corr-${n}`): IncomingMessage => ({
  offset: String(100 + n),
  key: VEHICLE,
  value: JSON.stringify(rawEvent(n, pointOverrides)),
  correlationId,
});

const rawMessage = (offset: number, value: string | null, correlationId = `corr-${offset}`): IncomingMessage => ({
  offset: String(offset),
  key: VEHICLE,
  value,
  correlationId,
});

const MADRID = { lon: -3.7038, lat: 40.4168 };
const DAY_MS = 86_400_000;
/** recordedAt `days` días antes de NOW, más `extraMs` milisegundos. */
const agoDays = (days: number, extraMs = 0) => new Date(NOW.getTime() - days * DAY_MS + extraMs).toISOString();

const dataError = (code = "22008") => Object.assign(new Error("date/time field value out of range"), { code });
const connectionError = () => Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });

class Timeline {
  readonly events: string[] = [];
  add(event: string) {
    this.events.push(event);
  }
  indexOf(event: string) {
    return this.events.indexOf(event);
  }
}

/** Almacén en memoria con la semántica de la tabla: único por (eventId, instante de recordedAt) y atómico. */
class FakeRepository implements TelemetryRepository {
  readonly rows = new Map<string, TelemetryRawEvent>();
  readonly calls: TelemetryRawEvent[][] = [];
  /** Devuelve un error para fallar esta llamada (sin insertar nada) o `undefined` para dejarla pasar. */
  failWhen: (events: readonly TelemetryRawEvent[], callNumber: number) => Error | undefined = () => undefined;

  constructor(private readonly timeline: Timeline) {}

  insertBatch(events: readonly TelemetryRawEvent[]): Promise<InsertOutcome> {
    this.calls.push([...events]);
    this.timeline.add(`insert:${events.length}`);
    const failure = this.failWhen(events, this.calls.length);
    if (failure !== undefined) return Promise.reject(failure);
    let inserted = 0;
    for (const event of events) {
      const key = `${event.point.eventId}|${Date.parse(event.point.recordedAt)}`;
      if (!this.rows.has(key)) {
        this.rows.set(key, event);
        inserted += 1;
      }
    }
    return Promise.resolve({ inserted });
  }
}

/** Estado de la flota en memoria: devuelve un `vehicle.state` por vehículo tocado y registra lo que recibe, en orden. */
class FakeFleet implements FleetStateUpdater {
  readonly applied: (readonly FleetTelemetry[])[] = [];
  readonly published: FleetUpdate[] = [];
  /** Devuelve un error para fallar esta llamada de `apply` o `undefined` para dejarla pasar. */
  applyFailWhen: (items: readonly FleetTelemetry[], callNumber: number) => Error | undefined = () => undefined;
  publishFailure: Error | undefined;
  /** Si no es `undefined`, se invoca en cada `publish` antes de registrarlo (un test lo usa para fallar solo la segunda vez). */
  onPublish: ((callNumber: number) => Error | undefined) | undefined;
  private publishCalls = 0;

  constructor(private readonly timeline: Timeline) {}

  apply(items: readonly FleetTelemetry[]): Promise<FleetUpdate> {
    this.applied.push([...items]);
    this.timeline.add(`fleet:apply:${items.length}`);
    const failure = this.applyFailWhen(items, this.applied.length);
    if (failure !== undefined) return Promise.reject(failure);
    const vehicles = new Map(items.map(({ event, correlationId }) => [event.point.vehicleId, { tenantId: event.tenantId, correlationId }]));
    return Promise.resolve({
      vehicleStates: [...vehicles].map(([vehicleId, { tenantId, correlationId }]) => ({ key: vehicleId, correlationId, event: stateEventOf(vehicleId, tenantId) })),
      alerts: [],
      stats: { vehicles: vehicles.size, statesWritten: vehicles.size, alertsRaised: 0, alertsResolved: 0 },
    });
  }

  publish(update: FleetUpdate): Promise<void> {
    this.publishCalls += 1;
    this.timeline.add("fleet:publish");
    const failure = this.publishFailure ?? this.onPublish?.(this.publishCalls);
    if (failure !== undefined) return Promise.reject(failure);
    this.published.push(update);
    return Promise.resolve();
  }
}

const stateEventOf = (vehicleId: string, tenantId: string): VehicleStateEvent => ({
  schemaVersion: 1,
  tenantId,
  state: {
    vehicleId,
    plate: "ABC123",
    lon: -75.5636,
    lat: 6.2518,
    recordedAt: "2026-03-14T19:59:30.000Z",
    receivedAt: "2026-03-14T20:00:00.000Z",
    speedMps: 12.5,
    headingDeg: 90,
    movement: "moving",
    stoppedSince: null,
    zoneIds: [],
    mocked: false,
    lowAccuracy: false,
    seq: "1",
  },
});

class FakeDeadLetters implements DeadLetterPublisher {
  readonly published: DeadLetterEntry[] = [];
  readonly calls: DeadLetterEntry[][] = [];
  failure: Error | undefined;

  constructor(private readonly timeline: Timeline) {}

  publish(entries: readonly DeadLetterEntry[]): Promise<void> {
    this.calls.push([...entries]);
    this.timeline.add(`dlq:${entries.length}`);
    if (this.failure !== undefined) return Promise.reject(this.failure);
    this.published.push(...entries);
    return Promise.resolve();
  }
}

class FakeCheckpoint implements BatchCheckpoint {
  readonly resolved: string[] = [];
  /** Offsets confirmados en el broker, en orden. */
  readonly committed: string[] = [];
  heartbeats = 0;
  /** Cuántas veces `shouldContinue` responde `true` antes de pasar a `false`. */
  continueFor = Number.POSITIVE_INFINITY;
  private checks = 0;

  constructor(private readonly timeline: Timeline) {}

  resolve(offset: string): void {
    this.resolved.push(offset);
    this.timeline.add(`resolve:${offset}`);
  }
  heartbeat(): Promise<void> {
    this.heartbeats += 1;
    return Promise.resolve();
  }
  commit(offset: string): Promise<void> {
    this.committed.push(offset);
    this.timeline.add(`commit:${offset}`);
    return Promise.resolve();
  }
  shouldContinue(): boolean {
    this.checks += 1;
    return this.checks <= this.continueFor;
  }
}

interface LogLine {
  level: "info" | "warn" | "error";
  fields: Record<string, unknown>;
  message: string;
}

function setup(
  options: {
    maxAttempts?: number;
    chunkSize?: number;
    random?: number;
    heartbeatIntervalMs?: number;
    sleeper?: Sleeper;
    backoff?: BackoffPolicy;
    /** Las llamadas del estado de la flota entran en la línea de tiempo compartida. Por defecto no, para no alterar el orden de los demás tests. */
    traceFleet?: boolean;
  } = {},
) {
  const timeline = new Timeline();
  const fleet = new FakeFleet(options.traceFleet === true ? timeline : new Timeline());
  const repository = new FakeRepository(timeline);
  const deadLetters = new FakeDeadLetters(timeline);
  const checkpoint = new FakeCheckpoint(timeline);
  const sleeps: number[] = [];
  const logs: LogLine[] = [];
  const logger: ProcessorLogger = {
    info: (fields, message) => logs.push({ level: "info", fields, message }),
    warn: (fields, message) => logs.push({ level: "warn", fields, message }),
    error: (fields, message) => logs.push({ level: "error", fields, message }),
  };
  const persist: PersistTelemetryBatch = createPersistTelemetryBatch({
    repository,
    fleetState: fleet,
    deadLetters,
    clock: { now: () => NOW },
    sleeper: options.sleeper ?? {
      sleep: (ms) => {
        sleeps.push(ms);
        timeline.add(`sleep:${ms}`);
        return Promise.resolve();
      },
    },
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 3_000,
    random: { next: () => options.random ?? 0 },
    logger,
    maxAttempts: options.maxAttempts ?? 3,
    backoff: options.backoff ?? { initialDelayMs: 100, maxDelayMs: 1_000 },
    chunkSize: options.chunkSize ?? 500,
  });
  const run = (messages: readonly IncomingMessage[], partition = 0): Promise<PersistReport> => persist({ partition, messages, checkpoint });
  return { timeline, repository, fleet, deadLetters, checkpoint, sleeps, logs, run };
}

const eventIds = (events: readonly TelemetryRawEvent[]) => events.map((event) => event.point.eventId);

describe("persistTelemetryBatch", () => {
  describe("camino feliz", () => {
    it("persiste los válidos en UN solo insert, resuelve el offset del último y no toca la DLQ", async () => {
      const { run, repository, deadLetters, checkpoint, sleeps } = setup();

      const report = await run([eventMessage(1), eventMessage(2), eventMessage(3)]);

      expect(repository.calls).toHaveLength(1);
      expect(eventIds(repository.calls[0] ?? [])).toEqual([uuidFor(1), uuidFor(2), uuidFor(3)]);
      expect(repository.rows.size).toBe(3);
      expect(deadLetters.calls).toEqual([]);
      expect(checkpoint.resolved).toEqual(["103"]);
      expect(checkpoint.heartbeats).toBe(1);
      // Confirma de verdad el offset resuelto (el siguiente a leer lo calcula la entrada), no solo lo pide "si hace falta".
      expect(checkpoint.committed).toEqual(["103"]);
      expect(sleeps).toEqual([]);
      expect(report).toEqual({
        persisted: 3,
        duplicates: 0,
        deadLettered: { invalid_schema: 0, stale_timestamp: 0, outside_operating_area: 0, processing_failed: 0 },
        stopped: false,
      });
    });

    it("un lote vacío no consulta nada ni resuelve offsets", async () => {
      const { run, repository, checkpoint } = setup();

      const report = await run([]);

      expect(repository.calls).toEqual([]);
      expect(checkpoint.resolved).toEqual([]);
      expect(report.persisted).toBe(0);
    });

    it("el tenant, el dispositivo y el vehículo que llegan en el evento (los del token) son los que se persisten", async () => {
      const { run, repository } = setup();

      await run([eventMessage(1)]);

      expect(repository.calls[0]?.[0]).toMatchObject({ tenantId: TENANT, deviceId: DEVICE, point: { vehicleId: VEHICLE } });
    });
  });

  describe("mensajes inválidos (sin reintentos)", () => {
    it("un texto que no es JSON va a la DLQ como invalid_schema con el string original, sin tocar la base ni reintentar", async () => {
      const { run, repository, deadLetters, sleeps } = setup();

      const report = await run([rawMessage(7, "{no es json", "corr-bad")]);

      expect(repository.calls).toEqual([]);
      expect(sleeps).toEqual([]);
      expect(deadLetters.published).toHaveLength(1);
      const entry = deadLetters.published[0];
      expect(entry?.correlationId).toBe("corr-bad");
      expect(entry?.key).toBe(VEHICLE);
      expect(telemetryDlqMessageSchema.parse(entry?.message)).toEqual({
        schemaVersion: 1,
        source: "processor",
        reason: { code: "invalid_schema", message: "El valor del mensaje no es JSON." },
        failedAt: NOW.toISOString(),
        tenantId: null,
        deviceId: null,
        vehicleId: null,
        eventId: null,
        attempts: 0,
        originalPayload: "{no es json",
      });
      expect(report.deadLettered.invalid_schema).toBe(1);
    });

    it("JSON que no cumple el contrato: el original es el valor parseado y se rescatan los ids", async () => {
      const { run, deadLetters } = setup();
      const raw = rawEvent(4, { lat: 999 });

      await run([rawMessage(4, JSON.stringify(raw))]);

      expect(deadLetters.published[0]?.message).toMatchObject({
        source: "processor",
        reason: { code: "invalid_schema", message: "Campos inválidos: point.lat." },
        tenantId: TENANT,
        deviceId: DEVICE,
        vehicleId: VEHICLE,
        eventId: uuidFor(4),
        attempts: 0,
        originalPayload: raw,
      });
    });

    it("un mensaje sin valor (tombstone) va a la DLQ con original null, y sin vehículo la key es la de Kafka", async () => {
      const { run, deadLetters } = setup();

      await run([{ offset: "9", key: "clave-original", value: null, correlationId: "corr-9" }]);

      expect(deadLetters.published[0]?.message.originalPayload).toBeNull();
      expect(deadLetters.published[0]?.key).toBe("clave-original");
    });

    it("sin vehículo conocido ni key de Kafka, la key de la DLQ es un valor fijo (la fábrica del productor exige key)", async () => {
      const { run, deadLetters } = setup();

      await run([{ offset: "9", key: null, value: "xx", correlationId: "corr-9" }]);

      expect(deadLetters.published[0]?.key).toBe("unknown");
    });

    it("el inválido en medio del lote no frena a los válidos: se persisten y todos los offsets se resuelven", async () => {
      const { run, repository, deadLetters, checkpoint } = setup();

      await run([eventMessage(1), rawMessage(102, "{roto"), eventMessage(3)]);

      expect(eventIds(repository.calls[0] ?? [])).toEqual([uuidFor(1), uuidFor(3)]);
      expect(deadLetters.published).toHaveLength(1);
      expect(checkpoint.resolved).toEqual(["103"]);
    });
  });

  describe("fuera del área de operación (sin reintentos)", () => {
    it("un punto en Madrid va a la DLQ como outside_operating_area, no se inserta y no se reintenta", async () => {
      const { run, repository, deadLetters, sleeps } = setup();

      const report = await run([eventMessage(5, MADRID, "corr-madrid")]);

      expect(repository.calls).toEqual([]);
      expect(sleeps).toEqual([]);
      expect(deadLetters.published).toHaveLength(1);
      expect(deadLetters.published[0]?.correlationId).toBe("corr-madrid");
      expect(telemetryDlqMessageSchema.parse(deadLetters.published[0]?.message)).toMatchObject({
        source: "processor",
        reason: { code: "outside_operating_area", message: "El punto está fuera del área de operación." },
        tenantId: TENANT,
        deviceId: DEVICE,
        vehicleId: VEHICLE,
        eventId: uuidFor(5),
        attempts: 0,
        originalPayload: rawEvent(5, MADRID),
      });
      expect(report.deadLettered.outside_operating_area).toBe(1);
    });

    it("la razón de la DLQ no lleva coordenadas", async () => {
      const { run, deadLetters } = setup();

      await run([eventMessage(5, MADRID)]);

      expect(deadLetters.published[0]?.message.reason.message).not.toMatch(/3\.7|40\.4/);
    });
  });

  describe("fallos transitorios", () => {
    it("un fallo transitorio que se recupera: reintenta con backoff y persiste, sin DLQ", async () => {
      const { run, repository, deadLetters, sleeps, checkpoint, timeline } = setup();
      repository.failWhen = (_events, call) => (call === 1 ? connectionError() : undefined);

      const report = await run([eventMessage(1), eventMessage(2)]);

      expect(repository.calls).toHaveLength(2);
      expect(repository.rows.size).toBe(2);
      expect(sleeps).toEqual([50]);
      expect(deadLetters.calls).toEqual([]);
      expect(checkpoint.resolved).toEqual(["102"]);
      expect(report.persisted).toBe(2);
      // El offset solo se resuelve después de persistir.
      expect(timeline.indexOf("resolve:102")).toBeGreaterThan(timeline.events.lastIndexOf("insert:2"));
    });

    it("el backoff es exponencial con jitter entre la mitad del techo y el techo, y late el heartbeat entre intentos", async () => {
      const { run, repository, sleeps, checkpoint } = setup({ maxAttempts: 4, random: 0 });
      repository.failWhen = (_events, call) => (call <= 3 ? connectionError() : undefined);

      await run([eventMessage(1)]);

      expect(sleeps).toEqual([50, 100, 200]);
      // Un heartbeat tras cada espera más el del final del tramo.
      expect(checkpoint.heartbeats).toBe(4);
    });

    it("con random casi 1 la espera es el techo", async () => {
      const { run, repository, sleeps } = setup({ maxAttempts: 4, random: 0.999999 });
      repository.failWhen = (_events, call) => (call <= 3 ? connectionError() : undefined);

      await run([eventMessage(1)]);

      expect(sleeps).toEqual([100, 200, 400]);
    });

    it("transitorio agotado: lanza PersistenceUnavailableError, NO va a la DLQ y no resuelve ningún offset", async () => {
      const { run, repository, deadLetters, checkpoint, sleeps } = setup({ maxAttempts: 3 });
      repository.failWhen = () => connectionError();

      const failure = await run([eventMessage(1), eventMessage(2)]).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(PersistenceUnavailableError);
      expect(failure).toMatchObject({ attempts: 3, cause: { code: "ECONNREFUSED" } });
      expect(repository.calls).toHaveLength(3);
      expect(sleeps).toHaveLength(2);
      expect(deadLetters.calls).toEqual([]);
      expect(checkpoint.resolved).toEqual([]);
      expect(checkpoint.committed).toEqual([]);
    });

    it("con maxAttempts 1 no hay reintentos", async () => {
      const { run, repository, sleeps } = setup({ maxAttempts: 1 });
      repository.failWhen = () => connectionError();

      await expect(run([eventMessage(1)])).rejects.toBeInstanceOf(PersistenceUnavailableError);

      expect(repository.calls).toHaveLength(1);
      expect(sleeps).toEqual([]);
    });

    it.each(["57P01", "53300", "40001", "40P01", "08006"])("el SQLSTATE %s se reintenta", async (code) => {
      const { run, repository, sleeps } = setup();
      repository.failWhen = (_events, call) => (call === 1 ? Object.assign(new Error("x"), { code }) : undefined);

      await run([eventMessage(1)]);

      expect(sleeps).toHaveLength(1);
      expect(repository.rows.size).toBe(1);
    });

    it("el inválido y el fuera de área del mismo tramo no llegan a la DLQ mientras la base está caída (no se duplican en cada reentrega)", async () => {
      const { run, repository, deadLetters } = setup({ maxAttempts: 2 });
      repository.failWhen = () => connectionError();

      await expect(run([eventMessage(1), rawMessage(102, "{roto"), eventMessage(3, MADRID)])).rejects.toBeInstanceOf(PersistenceUnavailableError);

      expect(deadLetters.calls).toEqual([]);
    });
  });

  describe("fila venenosa (fallo permanente)", () => {
    const poisonId = uuidFor(2);
    const failsWithPoison = (events: readonly TelemetryRawEvent[]) => (eventIds(events).includes(poisonId) ? dataError("22008") : undefined);

    it("un fallo permanente del lote se aísla fila por fila: la mala va a la DLQ como processing_failed con attempts y las demás se persisten", async () => {
      const { run, repository, deadLetters, checkpoint, sleeps } = setup();
      repository.failWhen = failsWithPoison;

      const report = await run([eventMessage(1), eventMessage(2, {}, "corr-poison"), eventMessage(3)]);

      // 1 intento del lote y 1 por fila, sin reintentos ni esperas (el error es permanente).
      expect(repository.calls.map((call) => call.length)).toEqual([3, 1, 1, 1]);
      expect(sleeps).toEqual([]);
      expect([...repository.rows.values()].map((event) => event.point.eventId).sort()).toEqual([uuidFor(1), uuidFor(3)]);
      expect(deadLetters.published).toHaveLength(1);
      expect(deadLetters.published[0]?.correlationId).toBe("corr-poison");
      expect(telemetryDlqMessageSchema.parse(deadLetters.published[0]?.message)).toMatchObject({
        source: "processor",
        reason: { code: "processing_failed", message: "Falló la persistencia (código 22008)." },
        tenantId: TENANT,
        vehicleId: VEHICLE,
        eventId: poisonId,
        attempts: 1,
        originalPayload: rawEvent(2),
      });
      expect(checkpoint.resolved).toEqual(["103"]);
      expect(report).toMatchObject({ persisted: 2, duplicates: 0, deadLettered: { processing_failed: 1 } });
    });

    it("la razón de processing_failed no cita el mensaje del error de la base (puede traer la fila)", async () => {
      const { run, repository, deadLetters } = setup();
      repository.failWhen = (events) =>
        eventIds(events).includes(poisonId) ? Object.assign(new Error("Failing row contains (-75.5636, 6.2518)"), { code: "23502" }) : undefined;

      await run([eventMessage(1), eventMessage(2)]);

      expect(deadLetters.published[0]?.message.reason.message).toBe("Falló la persistencia (código 23502).");
    });

    it("una fila que falló con un transitorio y luego con uno permanente cuenta todos sus intentos", async () => {
      const { run, repository, deadLetters, sleeps } = setup({ maxAttempts: 5 });
      let singleCalls = 0;
      // La fila 3 es buena: si fallaran TODAS las filas aisladas no habría una fila venenosa sino un problema de la base.
      repository.failWhen = (events) => {
        if (events.length > 1) return dataError();
        if (eventIds(events).includes(uuidFor(3))) return undefined;
        singleCalls += 1;
        return singleCalls === 1 ? connectionError() : dataError();
      };

      await run([eventMessage(1), eventMessage(2), eventMessage(3)]);

      // Fila 1: transitorio y luego permanente (2 intentos). Fila 2: permanente (1 intento). Fila 3: persistida.
      expect(sleeps).toEqual([50]);
      expect(deadLetters.published.map((entry) => entry.message.attempts)).toEqual([2, 1]);
      expect(repository.rows.size).toBe(1);
    });

    it("un tramo con una sola fila mala la manda a la DLQ y no persiste nada", async () => {
      const { run, repository, deadLetters } = setup();
      repository.failWhen = () => dataError();

      const report = await run([eventMessage(1)]);

      expect(repository.rows.size).toBe(0);
      expect(deadLetters.published).toHaveLength(1);
      expect(report).toMatchObject({ persisted: 0, deadLettered: { processing_failed: 1 } });
    });

    it("si durante el aislamiento una fila agota un fallo transitorio, el error sube y no se resuelve el tramo (las filas ya guardadas son no-op al reentregar)", async () => {
      const { run, repository, deadLetters, checkpoint } = setup({ maxAttempts: 2 });
      repository.failWhen = (events) => {
        if (events.length > 1) return dataError();
        return eventIds(events).includes(uuidFor(2)) ? connectionError() : undefined;
      };

      await expect(run([eventMessage(1), eventMessage(2), eventMessage(3)])).rejects.toBeInstanceOf(PersistenceUnavailableError);

      expect(repository.rows.size).toBe(1);
      expect(deadLetters.calls).toEqual([]);
      expect(checkpoint.resolved).toEqual([]);
    });

    it("un tramo con válidos, un inválido, un punto fuera de área y una fila venenosa: persiste primero y luego publica UNA vez la DLQ, antes de resolver", async () => {
      const { run, repository, deadLetters, timeline, checkpoint } = setup();
      repository.failWhen = failsWithPoison;

      const report = await run([eventMessage(1), eventMessage(2), rawMessage(103, "{roto"), eventMessage(4, MADRID), eventMessage(5)]);

      expect(report).toMatchObject({
        persisted: 2,
        deadLettered: { invalid_schema: 1, outside_operating_area: 1, processing_failed: 1 },
      });
      expect(deadLetters.calls).toHaveLength(1);
      expect(deadLetters.calls[0]?.map((entry) => entry.message.reason.code).sort()).toEqual([
        "invalid_schema",
        "outside_operating_area",
        "processing_failed",
      ]);
      const lastInsert = Math.max(...timeline.events.map((event, i) => (event.startsWith("insert:") ? i : -1)));
      expect(timeline.indexOf("dlq:3")).toBeGreaterThan(lastInsert);
      expect(timeline.indexOf("resolve:105")).toBeGreaterThan(timeline.indexOf("dlq:3"));
      expect(checkpoint.resolved).toEqual(["105"]);
    });
  });

  describe("falla en cerrado: solo es permanente lo atribuible a la fila (SQLSTATE clase 22 o 23)", () => {
    // Antes todo lo no listado como transitorio era permanente: tras reiniciar la base, el backlog entero terminaba en la DLQ con el
    // offset confirmado, y el móvil ya había borrado esos puntos al recibir el 202. Pérdida silenciosa.
    it.each(["57P03", "57014", "25006", "42501", "42P01", "42703", "3D000", "28P01", "53100", "53200"])(
      "con el SQLSTATE %s de la base el lote NO va a la DLQ: se reintenta, el error sube y el offset no se resuelve",
      async (code) => {
        const { run, repository, deadLetters, checkpoint, sleeps } = setup({ maxAttempts: 3 });
        repository.failWhen = () => Object.assign(new Error("fallo de la base"), { code });

        const failure = await run([eventMessage(1), eventMessage(2), eventMessage(3)]).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(PersistenceUnavailableError);
        expect(failure).toMatchObject({ attempts: 3, cause: { code } });
        expect(repository.calls).toHaveLength(3);
        expect(sleeps).toHaveLength(2);
        expect(deadLetters.calls).toEqual([]);
        expect(checkpoint.resolved).toEqual([]);
        expect(checkpoint.committed).toEqual([]);
      },
    );

    it("un error sin código también se reintenta y termina sin DLQ ni offset resuelto", async () => {
      const { run, repository, deadLetters, checkpoint } = setup({ maxAttempts: 2 });
      repository.failWhen = () => new Error("algo que no se reconoce");

      await expect(run([eventMessage(1), eventMessage(2)])).rejects.toBeInstanceOf(PersistenceUnavailableError);

      expect(repository.calls).toHaveLength(2);
      expect(deadLetters.calls).toEqual([]);
      expect(checkpoint.resolved).toEqual([]);
    });

    it("al agotar los reintentos deja un log de error con el código, sin datos del mensaje: la partición se detiene a la vista", async () => {
      const { run, repository, logs } = setup({ maxAttempts: 2 });
      repository.failWhen = () => Object.assign(new Error("Failing row contains (-75.5636, 6.2518)"), { code: "57P03" });

      await expect(run([eventMessage(1)])).rejects.toBeInstanceOf(PersistenceUnavailableError);

      const error = logs.find((line) => line.level === "error");
      expect(error?.fields).toMatchObject({ partition: 0, failure: "código 57P03" });
      expect(JSON.stringify(logs)).not.toMatch(/75\.5636|6\.2518|Failing/);
    });

    it("si fallan TODAS las filas aisladas (con más de una) no hay una fila venenosa: es la base. Lanza PersistenceUnavailableError, sin DLQ y sin resolver", async () => {
      const { run, repository, deadLetters, checkpoint, logs } = setup();
      repository.failWhen = () => dataError("23514");

      const failure = await run([eventMessage(1), eventMessage(2), eventMessage(3)]).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(PersistenceUnavailableError);
      expect(failure).toMatchObject({ cause: { code: "23514" } });
      // 1 intento del lote y 1 por fila.
      expect(repository.calls.map((call) => call.length)).toEqual([3, 1, 1, 1]);
      expect(deadLetters.calls).toEqual([]);
      expect(checkpoint.resolved).toEqual([]);
      expect(checkpoint.committed).toEqual([]);
      expect(logs.some((line) => line.level === "error")).toBe(true);
    });

    it("con inválidos de esquema en el tramo, si fallan todas las filas aisladas tampoco se publica nada en la DLQ", async () => {
      const { run, repository, deadLetters } = setup();
      repository.failWhen = () => dataError("22003");

      await expect(run([eventMessage(1), rawMessage(102, "{roto"), eventMessage(3)])).rejects.toBeInstanceOf(PersistenceUnavailableError);

      expect(deadLetters.calls).toEqual([]);
    });

    it("una sola fila en el tramo que falla de forma permanente SÍ va a la DLQ (no hay con qué compararla)", async () => {
      const { run, repository, deadLetters } = setup();
      repository.failWhen = () => dataError("22003");

      const report = await run([eventMessage(1)]);

      expect(deadLetters.published).toHaveLength(1);
      expect(report.deadLettered.processing_failed).toBe(1);
    });

    it("late el heartbeat después de CADA fila aislada", async () => {
      const { run, repository, checkpoint } = setup();
      repository.failWhen = (events) => (eventIds(events).includes(uuidFor(2)) ? dataError("22008") : undefined);

      await run([eventMessage(1), eventMessage(2), eventMessage(3), eventMessage(4)]);

      // 4 filas aisladas = 4 heartbeats, más el del final del tramo.
      expect(checkpoint.heartbeats).toBe(4 + 1);
    });

    it("pregunta shouldContinue antes de cada fila aislada; si da falso sale sin publicar la DLQ ni resolver el tramo", async () => {
      const { run, repository, deadLetters, checkpoint } = setup();
      repository.failWhen = (events) => (eventIds(events).includes(uuidFor(1)) ? dataError("22008") : undefined);
      // 1.ª consulta (el tramo): sí. 2.ª (fila 1): sí. 3.ª (fila 2): no.
      checkpoint.continueFor = 2;

      const report = await run([eventMessage(1), eventMessage(2), eventMessage(3)]);

      expect(report.stopped).toBe(true);
      // Lote entero + fila 1; la fila 2 ya no se intenta.
      expect(repository.calls.map((call) => call.length)).toEqual([3, 1]);
      expect(deadLetters.calls).toEqual([]);
      expect(checkpoint.resolved).toEqual([]);
      expect(checkpoint.committed).toEqual([]);
    });

    it("si el consumer se detiene a mitad del aislamiento, lo ya insertado cuenta en el informe", async () => {
      const { run, repository, checkpoint } = setup();
      repository.failWhen = (events) => (events.length > 1 ? dataError("22008") : undefined);
      // El tramo y las filas 1 y 2: sí. La fila 3: no.
      checkpoint.continueFor = 3;

      const report = await run([eventMessage(1), eventMessage(2), eventMessage(3)]);

      expect(report).toMatchObject({ stopped: true, persisted: 2 });
      expect(repository.rows.size).toBe(2);
    });
  });

  describe("antigüedad (defensa en profundidad)", () => {
    it("un punto de más de 90 días (la retención) va a la DLQ como stale_timestamp, sin reintentos y sin insertarse", async () => {
      const { run, repository, deadLetters, sleeps, checkpoint } = setup();

      const report = await run([eventMessage(1, { recordedAt: agoDays(90, -1) }, "corr-stale")]);

      expect(repository.calls).toEqual([]);
      expect(sleeps).toEqual([]);
      expect(deadLetters.published).toHaveLength(1);
      expect(deadLetters.published[0]?.correlationId).toBe("corr-stale");
      expect(telemetryDlqMessageSchema.parse(deadLetters.published[0]?.message)).toMatchObject({
        source: "processor",
        reason: { code: "stale_timestamp" },
        tenantId: TENANT,
        vehicleId: VEHICLE,
        eventId: uuidFor(1),
        attempts: 0,
      });
      expect(report.deadLettered.stale_timestamp).toBe(1);
      expect(checkpoint.resolved).toEqual(["101"]);
    });

    it("exactamente 90 días se persiste", async () => {
      const { run, repository } = setup();

      const report = await run([eventMessage(1, { recordedAt: agoDays(90) })]);

      expect(repository.rows.size).toBe(1);
      expect(report.deadLettered.stale_timestamp).toBe(0);
    });

    it("puntos de 8 y 30 días (que el gateway rechazaría hoy pero pudo aceptar y dejar esperando en Kafka) SE persisten", async () => {
      const { run, repository, deadLetters } = setup();

      await run([eventMessage(1, { recordedAt: agoDays(30) }), eventMessage(2, { recordedAt: agoDays(8) })]);

      expect(repository.rows.size).toBe(2);
      expect(deadLetters.calls).toEqual([]);
    });

    it("la razón no lleva fechas ni coordenadas", async () => {
      const { run, deadLetters } = setup();

      await run([eventMessage(1, { recordedAt: agoDays(200) })]);

      expect(deadLetters.published[0]?.message.reason.message).not.toMatch(/20\d\d|75\.5636|6\.2518/);
    });
  });

  describe("espera del backoff con heartbeat (una espera no puede superar el sessionTimeout sin latir)", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("una espera más larga que el intervalo se parte en tramos, con un heartbeat después de cada uno", async () => {
      // Espera de 50 ms (techo 100, jitter 0) en tramos de 20 ms.
      const { run, repository, sleeps, checkpoint } = setup({ maxAttempts: 2, random: 0, heartbeatIntervalMs: 20 });
      repository.failWhen = (_events, call) => (call === 1 ? connectionError() : undefined);

      await run([eventMessage(1)]);

      expect(sleeps).toEqual([20, 20, 10]);
      // 3 tramos de espera + el del final del tramo de mensajes.
      expect(checkpoint.heartbeats).toBe(3 + 1);
    });

    it("una espera que cabe en un tramo late una sola vez", async () => {
      const { run, repository, sleeps, checkpoint } = setup({ maxAttempts: 2, random: 0, heartbeatIntervalMs: 3_000 });
      repository.failWhen = (_events, call) => (call === 1 ? connectionError() : undefined);

      await run([eventMessage(1)]);

      expect(sleeps).toEqual([50]);
      expect(checkpoint.heartbeats).toBe(1 + 1);
    });

    it("con fake timers: durante una espera de 10 s el heartbeat late cada 3 s, no una sola vez al final", async () => {
      vi.useFakeTimers();
      // Techo de 20 000 ms con jitter 0: espera de 10 000 ms.
      const { run, repository, checkpoint } = setup({
        maxAttempts: 2,
        random: 0,
        heartbeatIntervalMs: 3_000,
        backoff: { initialDelayMs: 20_000, maxDelayMs: 20_000 },
        sleeper: { sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
      });
      repository.failWhen = (_events, call) => (call === 1 ? connectionError() : undefined);

      const outcome = run([eventMessage(1)]);

      await vi.advanceTimersByTimeAsync(2_999);
      expect(checkpoint.heartbeats).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(checkpoint.heartbeats).toBe(1);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(checkpoint.heartbeats).toBe(2);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(checkpoint.heartbeats).toBe(3);
      // Último tramo de 1 000 ms; luego el reintento persiste y se cierra el tramo (un heartbeat más).
      await vi.advanceTimersByTimeAsync(1_000);
      await outcome;

      expect(checkpoint.heartbeats).toBe(5);
      expect(repository.rows.size).toBe(1);
    });

    it("si el heartbeat falla durante la espera (rebalanceo), el error se propaga y no se reintenta", async () => {
      const { run, repository, checkpoint } = setup({ maxAttempts: 3, heartbeatIntervalMs: 3_000 });
      repository.failWhen = () => connectionError();
      checkpoint.heartbeat = () => Promise.reject(new Error("rebalanceo"));

      await expect(run([eventMessage(1)])).rejects.toThrow("rebalanceo");

      expect(repository.calls).toHaveLength(1);
    });
  });

  describe("DLQ", () => {
    it("si la publicación a la DLQ falla, lanza DeadLetterPublicationError y no resuelve el offset del tramo", async () => {
      const { run, deadLetters, checkpoint, repository } = setup();
      deadLetters.failure = new Error("broker caído");

      const failure = await run([eventMessage(1), rawMessage(102, "{roto")]).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(DeadLetterPublicationError);
      expect(failure).toMatchObject({ messages: 1, cause: { message: "broker caído" } });
      // Lo válido ya se guardó (idempotente al reentregar), pero el offset no avanza.
      expect(repository.rows.size).toBe(1);
      expect(checkpoint.resolved).toEqual([]);
      expect(checkpoint.committed).toEqual([]);
    });

    it("cada entrada de la DLQ lleva el correlationId de SU mensaje", async () => {
      const { run, deadLetters } = setup();

      await run([rawMessage(1, "{a", "corr-a"), eventMessage(2, MADRID, "corr-b"), rawMessage(3, "{c", "corr-c")]);

      expect(deadLetters.published.map((entry) => entry.correlationId)).toEqual(["corr-a", "corr-b", "corr-c"]);
    });

    it("el mensaje de la DLQ cumple el contrato (productor estricto)", async () => {
      const { run, deadLetters } = setup();

      await run([rawMessage(1, "{a"), eventMessage(2, MADRID)]);

      expect(deadLetters.published).toHaveLength(2);
      for (const entry of deadLetters.published) expect(() => telemetryDlqMessageSchema.parse(entry.message)).not.toThrow();
    });
  });

  describe("idempotencia", () => {
    it("el mismo mensaje dos veces en el mismo lote deja una sola fila y cuenta un duplicado", async () => {
      const { run, repository } = setup();

      const report = await run([eventMessage(1), { ...eventMessage(1), offset: "150" }]);

      expect(repository.rows.size).toBe(1);
      expect(report).toMatchObject({ persisted: 1, duplicates: 1 });
    });

    it("reentregar el mismo lote (como tras un fallo antes de confirmar) no agrega filas", async () => {
      const { run, repository } = setup();
      const batch = [eventMessage(1), eventMessage(2)];

      const first = await run(batch);
      const second = await run(batch);

      expect(repository.rows.size).toBe(2);
      expect(first).toMatchObject({ persisted: 2, duplicates: 0 });
      expect(second).toMatchObject({ persisted: 0, duplicates: 2 });
    });

    it("el mismo eventId con otro offset de hora (misma instancia en otra zona) sigue siendo el mismo punto", async () => {
      const { run, repository } = setup();

      await run([eventMessage(1, { recordedAt: "2026-03-14T14:59:30.000-05:00" }), eventMessage(1, { recordedAt: "2026-03-14T19:59:30.000Z" })]);

      expect(repository.rows.size).toBe(1);
    });
  });

  describe("tramos, heartbeat y offsets", () => {
    it("un lote largo se procesa por tramos: cada uno es un insert, resuelve su último offset y late el heartbeat", async () => {
      const { run, repository, checkpoint } = setup({ chunkSize: 2 });

      const report = await run([1, 2, 3, 4, 5].map((n) => eventMessage(n)));

      expect(repository.calls.map((call) => call.length)).toEqual([2, 2, 1]);
      expect(checkpoint.resolved).toEqual(["102", "104", "105"]);
      expect(checkpoint.heartbeats).toBe(3);
      expect(checkpoint.committed).toEqual(["102", "104", "105"]);
      expect(report.persisted).toBe(5);
    });

    it("si un tramo falla, el progreso de los anteriores se conserva (ya estaban resueltos)", async () => {
      const { run, repository, checkpoint } = setup({ chunkSize: 2, maxAttempts: 1 });
      repository.failWhen = (_events, call) => (call === 2 ? connectionError() : undefined);

      await expect(run([1, 2, 3, 4].map((n) => eventMessage(n)))).rejects.toBeInstanceOf(PersistenceUnavailableError);

      expect(checkpoint.resolved).toEqual(["102"]);
    });

    it("la DLQ de un tramo se confirma antes de resolver SU offset, no el de otro", async () => {
      const { run, timeline } = setup({ chunkSize: 2 });

      await run([rawMessage(10, "{a"), { ...eventMessage(1), offset: "11" }, { ...eventMessage(2), offset: "12" }, rawMessage(13, "{b")]);

      expect(timeline.events).toEqual(["insert:1", "dlq:1", "resolve:11", "commit:11", "insert:1", "dlq:1", "resolve:13", "commit:13"]);
    });

    it("un tramo sin válidos no consulta la base, pero sí resuelve tras confirmar su DLQ", async () => {
      const { run, repository, timeline } = setup();

      await run([rawMessage(10, "{a"), rawMessage(11, "{b")]);

      expect(repository.calls).toEqual([]);
      expect(timeline.events).toEqual(["dlq:2", "resolve:11", "commit:11"]);
    });

    it("si el consumer se detiene o la partición se reasigna, deja de procesar sin error y sin resolver lo pendiente", async () => {
      const { run, repository, checkpoint } = setup({ chunkSize: 2 });
      checkpoint.continueFor = 1;

      const report = await run([1, 2, 3, 4].map((n) => eventMessage(n)));

      expect(report.stopped).toBe(true);
      expect(repository.calls).toHaveLength(1);
      expect(checkpoint.resolved).toEqual(["102"]);
    });

    it("un fallo del heartbeat (rebalanceo) se propaga y no se traga", async () => {
      const { run, checkpoint } = setup({ chunkSize: 1 });
      checkpoint.heartbeat = () => Promise.reject(new Error("rebalanceo"));

      await expect(run([eventMessage(1), eventMessage(2)])).rejects.toThrow("rebalanceo");

      // El offset del tramo ya persistido sí quedó resuelto; el siguiente no se tocó.
      expect(checkpoint.resolved).toEqual(["101"]);
    });
  });

  describe("versión del esquema mayor que la conocida (hallazgo M-b): transitorio, no va a la DLQ", () => {
    const futureMessage = (offset: number, correlationId = `corr-${offset}`): IncomingMessage => ({
      offset: String(offset),
      key: VEHICLE,
      value: JSON.stringify({ ...rawEvent(offset), schemaVersion: 2 }),
      correlationId,
    });

    it("lanza UnsupportedSchemaVersionError: no publica en la DLQ, no persiste el tramo y no resuelve ni confirma su offset", async () => {
      const { run, repository, deadLetters, checkpoint } = setup();

      await expect(run([eventMessage(1), futureMessage(102), eventMessage(3)])).rejects.toBeInstanceOf(UnsupportedSchemaVersionError);

      expect(deadLetters.calls).toEqual([]);
      expect(repository.calls).toEqual([]);
      expect(checkpoint.resolved).toEqual([]);
      expect(checkpoint.committed).toEqual([]);
    });

    it("lo ya confirmado de tramos anteriores se conserva; la partición se detiene en el tramo con la versión nueva", async () => {
      const { run, repository, deadLetters, checkpoint } = setup({ chunkSize: 2 });

      await expect(run([eventMessage(1), eventMessage(2), eventMessage(3), futureMessage(104)])).rejects.toBeInstanceOf(UnsupportedSchemaVersionError);

      expect(repository.rows.size).toBe(2);
      expect(checkpoint.committed).toEqual(["102"]);
      expect(deadLetters.calls).toEqual([]);
    });

    it("el error lleva la versión y el offset, y se registra a la vista sin contenido del mensaje", async () => {
      const { run, logs } = setup();
      const error = await run([futureMessage(105, "corr-futuro")], 4).catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(UnsupportedSchemaVersionError);
      expect(error).toMatchObject({ version: 2, offset: "105" });
      const line = logs.find((entry) => entry.level === "error");
      expect(line?.fields).toMatchObject({ partition: 4, offset: "105", schemaVersion: 2, correlationId: "corr-futuro" });
      expect(JSON.stringify(logs)).not.toMatch(/75.5636|6.2518/);
    });

    it("un mensaje con versión 0 o inválida SÍ va a la DLQ como invalid_schema (es el contenido, no el despliegue)", async () => {
      const { run, deadLetters } = setup();
      const broken: IncomingMessage = { offset: "200", key: VEHICLE, value: JSON.stringify({ ...rawEvent(1), schemaVersion: 0 }), correlationId: "corr-v0" };

      await run([broken]);

      expect(deadLetters.published.map((entry) => entry.message.reason.code)).toEqual(["invalid_schema"]);
    });
  });

  describe("logs", () => {
    it("registra los conteos del tramo con el tenant y sin coordenadas ni contenido de mensajes", async () => {
      const { run, logs } = setup();

      await run([eventMessage(1), eventMessage(1), rawMessage(103, "{roto-con-6.2518"), eventMessage(4, MADRID)], 3);

      const summary = logs.find((line) => line.level === "info");
      expect(summary?.fields).toMatchObject({
        partition: 3,
        messages: 4,
        persisted: 1,
        duplicates: 1,
        deadLettered: { invalid_schema: 1, stale_timestamp: 0, outside_operating_area: 1, processing_failed: 0 },
        tenantIds: [TENANT],
      });
      const everything = JSON.stringify(logs);
      expect(everything).not.toMatch(/75\.5636|6\.2518|40\.4168|3\.7038|roto-con/);
    });

    it("cada mensaje a la DLQ deja un aviso con código, ids y correlationId (nunca el contenido)", async () => {
      const { run, logs } = setup();

      await run([eventMessage(5, MADRID, "corr-madrid")]);

      const warn = logs.find((line) => line.level === "warn");
      expect(warn?.fields).toMatchObject({
        code: "outside_operating_area",
        attempts: 0,
        eventId: uuidFor(5),
        tenantId: TENANT,
        vehicleId: VEHICLE,
        correlationId: "corr-madrid",
        offset: "105",
      });
      expect(JSON.stringify(warn)).not.toMatch(/-3\.7038|40\.4168/);
    });

    it("el reintento de un fallo transitorio se registra con el intento y la espera, solo con el código del error", async () => {
      const { run, repository, logs } = setup();
      repository.failWhen = (_events, call) => (call === 1 ? connectionError() : undefined);

      await run([eventMessage(1)]);

      const retry = logs.find((line) => line.level === "warn");
      expect(retry?.fields).toMatchObject({ attempt: 1, maxAttempts: 3, delayMs: 50, failure: "código ECONNREFUSED" });
      expect(JSON.stringify(retry)).not.toMatch(/127\.0\.0\.1/);
    });
  });

  describe("estado de la flota (fase 1b)", () => {
    const connectionDown = () => connectionError();
    const constraintViolation = () => Object.assign(new Error("insert or update on table violates foreign key constraint"), { code: "23503" });
    const forVehicle2 = (items: readonly FleetTelemetry[]) => items.some(({ event }) => event.point.vehicleId === VEHICLE_2);

    it("el orden de cada tramo es: persistir telemetría -> estado -> publicar eventos -> resolver offset -> confirmar", async () => {
      const { run, timeline } = setup({ traceFleet: true });

      await run([eventMessage(1), eventMessage(2), eventMessage(3)]);

      expect(timeline.events).toEqual(["insert:3", "fleet:apply:3", "fleet:publish", "resolve:103", "commit:103"]);
    });

    it("cada tramo se actualiza y se publica antes de resolver SU offset", async () => {
      const { run, timeline } = setup({ chunkSize: 2, traceFleet: true });

      await run([eventMessage(1), eventMessage(2), eventMessage(3)]);

      expect(timeline.events).toEqual([
        "insert:2",
        "fleet:apply:2",
        "fleet:publish",
        "resolve:102",
        "commit:102",
        "insert:1",
        "fleet:apply:1",
        "fleet:publish",
        "resolve:103",
        "commit:103",
      ]);
    });

    it("al estado llegan los puntos persistidos (también los duplicados), cada uno con el correlationId de SU mensaje y el tenant del evento", async () => {
      const { run, fleet } = setup();

      await run([eventMessage(1, {}, "corr-a"), eventMessage(1, {}, "corr-b"), eventMessage(2, {}, "corr-c")]);

      expect(fleet.applied).toHaveLength(1);
      expect(fleet.applied[0]?.map((item) => [item.event.point.eventId, item.event.tenantId, item.correlationId])).toEqual([
        [uuidFor(1), TENANT, "corr-a"],
        [uuidFor(1), TENANT, "corr-b"],
        [uuidFor(2), TENANT, "corr-c"],
      ]);
    });

    it("lo que no se persistió (inválido, fuera de área, fila venenosa) NO llega al estado, y va a la DLQ", async () => {
      const { run, fleet, repository, deadLetters } = setup();
      repository.failWhen = (events) => (events.some((event) => event.point.speedMps === 77.77) ? dataError("23514") : undefined);

      await run([eventMessage(1), eventMessage(2, { speedMps: 77.77 }), rawMessage(103, "{roto"), eventMessage(4, MADRID)]);

      const sentToState = fleet.applied.flatMap((items) => items.map((item) => item.event.point.eventId));
      expect(new Set(sentToState)).toEqual(new Set([uuidFor(1)]));
      expect(deadLetters.published).toHaveLength(3);
    });

    it("publica exactamente lo que devolvió el estado", async () => {
      const { run, fleet } = setup();

      await run([eventMessage(1, {}, "corr-pub")]);

      expect(fleet.published).toHaveLength(1);
      expect(fleet.published[0]?.vehicleStates).toEqual([{ key: VEHICLE, correlationId: "corr-pub", event: stateEventOf(VEHICLE, TENANT) }]);
    });

    it("un tramo sin válidos no toca el estado", async () => {
      const { run, fleet } = setup();

      await run([rawMessage(101, "{roto"), eventMessage(2, MADRID)]);

      expect(fleet.applied).toEqual([]);
    });

    it("reentregar el mismo tramo vuelve a pasar los puntos al estado (así se republica lo que quedó sin publicar tras un crash)", async () => {
      const { run, fleet } = setup();
      const batch = [eventMessage(1), eventMessage(2)];

      await run(batch);
      await run(batch);

      expect(fleet.applied).toHaveLength(2);
      expect(fleet.applied[1]?.map((item) => item.event.point.eventId)).toEqual([uuidFor(1), uuidFor(2)]);
      expect(fleet.published).toHaveLength(2);
    });

    describe("fallo de la publicación", () => {
      it("lanza FleetEventPublicationError con la causa y NO resuelve ni confirma el offset del tramo", async () => {
        const { run, fleet, checkpoint, repository } = setup();
        const cause = new Error("el broker no confirmó");
        fleet.publishFailure = cause;

        const error = await run([eventMessage(1), eventMessage(2)]).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(FleetEventPublicationError);
        expect(error).toMatchObject({ events: 1, cause });
        expect(checkpoint.resolved).toEqual([]);
        expect(checkpoint.committed).toEqual([]);
        // La telemetría y el estado ya quedaron: la reentrega es idempotente.
        expect(repository.rows.size).toBe(2);
      });

      it("el tramo anterior, ya publicado y resuelto, se conserva", async () => {
        const { run, fleet, checkpoint } = setup({ chunkSize: 1 });
        fleet.onPublish = (call) => (call === 2 ? new Error("falla") : undefined);

        await expect(run([eventMessage(1), eventMessage(2)])).rejects.toBeInstanceOf(FleetEventPublicationError);

        expect(checkpoint.resolved).toEqual(["101"]);
      });

      it("no se publica la DLQ del tramo (se reentrega todo junto)", async () => {
        const { run, fleet, deadLetters } = setup();
        fleet.publishFailure = new Error("falla");

        await expect(run([eventMessage(1), eventMessage(2, MADRID)])).rejects.toBeInstanceOf(FleetEventPublicationError);

        expect(deadLetters.calls).toEqual([]);
      });
    });

    describe("fallos de la base al actualizar el estado", () => {
      it("un fallo transitorio que se recupera: reintenta con backoff y publica una sola vez", async () => {
        const { run, fleet, sleeps, checkpoint } = setup();
        fleet.applyFailWhen = (_items, call) => (call === 1 ? connectionDown() : undefined);

        await run([eventMessage(1)]);

        expect(fleet.applied).toHaveLength(2);
        expect(sleeps).toEqual([50]);
        expect(fleet.published).toHaveLength(1);
        expect(checkpoint.resolved).toEqual(["101"]);
      });

      it("transitorio agotado: PersistenceUnavailableError, sin publicar, sin DLQ y sin resolver el offset; el log a la vista no lleva datos del mensaje", async () => {
        const { run, fleet, deadLetters, checkpoint, logs } = setup({ maxAttempts: 2 });
        fleet.applyFailWhen = () => connectionDown();

        const error = await run([eventMessage(1), rawMessage(102, "{roto")]).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(PersistenceUnavailableError);
        expect(fleet.applied).toHaveLength(2);
        expect(fleet.published).toEqual([]);
        expect(deadLetters.calls).toEqual([]);
        expect(checkpoint.resolved).toEqual([]);
        const line = logs.find((entry) => entry.level === "error");
        expect(line?.fields).toMatchObject({ step: "fleet_state", attempts: 2, failure: "código ECONNREFUSED" });
        expect(JSON.stringify(logs)).not.toMatch(/75\.5636|6\.2518/);
      });

      it("un error sin código también es transitorio (falla en cerrado): no va a la DLQ", async () => {
        const { run, fleet, deadLetters, checkpoint } = setup({ maxAttempts: 1 });
        fleet.applyFailWhen = () => new Error("algo raro");

        await expect(run([eventMessage(1)])).rejects.toBeInstanceOf(PersistenceUnavailableError);

        expect(deadLetters.calls).toEqual([]);
        expect(checkpoint.resolved).toEqual([]);
      });

      it("permanente (clase 23) en UN vehículo de dos: sus mensajes van a la DLQ como processing_failed y el otro vehículo se publica y se resuelve", async () => {
        const { run, fleet, deadLetters, checkpoint, repository } = setup();
        fleet.applyFailWhen = (items) => (forVehicle2(items) ? constraintViolation() : undefined);

        const report = await run([eventMessage(1), eventMessage(2, { vehicleId: VEHICLE_2 }, "corr-v2"), eventMessage(3)]);

        // La telemetría de los dos se guardó: lo que falló es la proyección, no el punto.
        expect(repository.rows.size).toBe(3);
        expect(report.deadLettered.processing_failed).toBe(1);
        expect(deadLetters.published).toHaveLength(1);
        expect(deadLetters.published[0]).toMatchObject({ key: VEHICLE_2, correlationId: "corr-v2" });
        expect(deadLetters.published[0]?.message).toMatchObject({
          source: "processor",
          reason: { code: "processing_failed", message: expect.stringContaining("23503") as string },
          vehicleId: VEHICLE_2,
          eventId: uuidFor(2),
          attempts: 1,
        });
        expect(fleet.published).toHaveLength(1);
        expect(fleet.published[0]?.vehicleStates.map((entry) => entry.key)).toEqual([VEHICLE]);
        expect(checkpoint.resolved).toEqual(["103"]);
      });

      it("la razón de la DLQ no cita el mensaje del error de la base (puede traer la fila)", async () => {
        const { run, fleet, deadLetters } = setup();
        fleet.applyFailWhen = (items) => (forVehicle2(items) ? constraintViolation() : undefined);

        await run([eventMessage(1), eventMessage(2, { vehicleId: VEHICLE_2 })]);

        expect(JSON.stringify(deadLetters.published)).not.toMatch(/violates foreign key/);
      });

      it("un solo vehículo en el tramo con fallo permanente SÍ va a la DLQ", async () => {
        const { run, fleet, deadLetters, checkpoint } = setup();
        fleet.applyFailWhen = () => constraintViolation();

        await run([eventMessage(1), eventMessage(2)]);

        expect(deadLetters.published.map((entry) => entry.message.reason.code)).toEqual(["processing_failed", "processing_failed"]);
        expect(checkpoint.resolved).toEqual(["102"]);
      });

      it("si fallan TODOS los vehículos aislados (con más de uno) no hay un vehículo venenoso: es la base. Sin DLQ y sin resolver", async () => {
        const { run, fleet, deadLetters, checkpoint } = setup();
        fleet.applyFailWhen = () => constraintViolation();

        await expect(run([eventMessage(1), eventMessage(2, { vehicleId: VEHICLE_2 })])).rejects.toBeInstanceOf(PersistenceUnavailableError);

        expect(deadLetters.calls).toEqual([]);
        expect(checkpoint.resolved).toEqual([]);
      });

      it("pregunta shouldContinue antes de cada vehículo aislado; si da falso sale sin publicar ni resolver", async () => {
        const { run, fleet, checkpoint, deadLetters } = setup();
        fleet.applyFailWhen = (_items, call) => (call === 1 ? constraintViolation() : undefined);
        // 1) antes del tramo; 2) antes del primer vehículo aislado; el tercero (segundo vehículo) ya no.
        checkpoint.continueFor = 2;

        const report = await run([eventMessage(1), eventMessage(2, { vehicleId: VEHICLE_2 })]);

        expect(report.stopped).toBe(true);
        expect(fleet.published).toEqual([]);
        expect(deadLetters.calls).toEqual([]);
        expect(checkpoint.resolved).toEqual([]);
      });
    });

    it("el resumen del tramo incluye los conteos del estado, sin coordenadas", async () => {
      const { run, logs } = setup();

      await run([eventMessage(1), eventMessage(2, { vehicleId: VEHICLE_2 })]);

      const summary = logs.find((line) => line.level === "info");
      expect(summary?.fields).toMatchObject({ fleet: { vehicles: 2, statesWritten: 2, alertsRaised: 0, alertsResolved: 0, events: 2 } });
      expect(JSON.stringify(logs)).not.toMatch(/75\.5636|6\.2518/);
    });
  });

});
