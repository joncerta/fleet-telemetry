import { CORRELATION_ID_HEADER } from "@fleet/platform";
import type { Offsets } from "kafkajs";
import { describe, expect, it, vi } from "vitest";
import type { PersistReport, PersistTelemetryBatch, PersistTelemetryInput } from "../../application/persist-telemetry-batch.js";
import { createTelemetryBatchHandler, type TelemetryBatchPayload } from "./telemetry-batch-handler.js";

const REPORT: PersistReport = {
  persisted: 0,
  duplicates: 0,
  deadLettered: { invalid_schema: 0, stale_timestamp: 0, outside_operating_area: 0, processing_failed: 0 },
  stopped: false,
};

function setup(overrides: { isRunning?: boolean; isStale?: boolean } = {}) {
  const inputs: PersistTelemetryInput[] = [];
  const persist: PersistTelemetryBatch = (input) => {
    inputs.push(input);
    return Promise.resolve(REPORT);
  };
  const resolveOffset = vi.fn<(offset: string) => void>();
  const heartbeat = vi.fn(() => Promise.resolve());
  const commitOffsetsIfNecessary = vi.fn((_offsets?: Offsets) => Promise.resolve());
  const payload = (messages: TelemetryBatchPayload["batch"]["messages"]): TelemetryBatchPayload => ({
    batch: { topic: "telemetry.raw", partition: 4, messages },
    resolveOffset,
    heartbeat,
    commitOffsetsIfNecessary,
    isRunning: () => overrides.isRunning ?? true,
    isStale: () => overrides.isStale ?? false,
  });
  return { handler: createTelemetryBatchHandler(persist), inputs, payload, resolveOffset, heartbeat, commitOffsetsIfNecessary };
}

describe("createTelemetryBatchHandler", () => {
  it("traduce el lote: partición, offsets, key y valor como UTF-8 y el correlationId del header de cada mensaje", async () => {
    const { handler, inputs, payload } = setup();

    await handler(
      payload([
        { offset: "10", key: Buffer.from("vehículo-1"), value: Buffer.from('{"a":"ñ"}'), headers: { [CORRELATION_ID_HEADER]: Buffer.from("corr-a") } },
        { offset: "11", key: null, value: null, headers: { [CORRELATION_ID_HEADER]: "corr-b" } },
      ]),
    );

    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.partition).toBe(4);
    expect(inputs[0]?.messages).toEqual([
      { offset: "10", key: "vehículo-1", value: '{"a":"ñ"}', correlationId: "corr-a" },
      { offset: "11", key: null, value: null, correlationId: "corr-b" },
    ]);
  });

  it("sin header correlationId (o con uno inválido) genera uno nuevo y válido por mensaje, para no perder la traza", async () => {
    const { handler, inputs, payload } = setup();

    await handler(
      payload([
        { offset: "1", key: null, value: null },
        { offset: "2", key: null, value: null, headers: { [CORRELATION_ID_HEADER]: Buffer.from("con espacios\n") } },
      ]),
    );

    const ids = inputs[0]?.messages.map((message) => message.correlationId) ?? [];
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
  });

  it("el checkpoint conecta resolveOffset y heartbeat del consumer", async () => {
    const { handler, inputs, payload, resolveOffset, heartbeat } = setup();
    await handler(payload([]));
    const checkpoint = inputs[0]?.checkpoint;

    checkpoint?.resolve("42");
    await checkpoint?.heartbeat();

    expect(resolveOffset).toHaveBeenCalledExactlyOnceWith("42");
    expect(heartbeat).toHaveBeenCalledOnce();
  });

  // Con kafkajs 2.2.4, commitOffsetsIfNecessary() SIN argumentos no confirma nada mientras no se cumpla un umbral (y no hay
  // ninguno): hay que pasarle los offsets explícitos de la partición, y el offset es el SIGUIENTE a leer.
  it("commit confirma YA, con los offsets explícitos de la partición y el siguiente offset a leer", async () => {
    const { handler, inputs, payload, commitOffsetsIfNecessary } = setup();
    await handler(payload([]));

    await inputs[0]?.checkpoint.commit("41");

    expect(commitOffsetsIfNecessary).toHaveBeenCalledExactlyOnceWith({
      topics: [{ topic: "telemetry.raw", partitions: [{ partition: 4, offset: "42" }] }],
    });
  });

  it("el siguiente offset se calcula como entero de 64 bits (sin perder precisión)", async () => {
    const { handler, inputs, payload, commitOffsetsIfNecessary } = setup();
    await handler(payload([]));

    await inputs[0]?.checkpoint.commit("9007199254740993");

    expect(commitOffsetsIfNecessary).toHaveBeenCalledWith({
      topics: [{ topic: "telemetry.raw", partitions: [{ partition: 4, offset: "9007199254740994" }] }],
    });
  });

  it("shouldContinue es falso si el consumer se detiene o la partición se reasignó (stale)", async () => {
    const running = setup();
    const stopping = setup({ isRunning: false });
    const stale = setup({ isStale: true });
    await Promise.all([running.handler(running.payload([])), stopping.handler(stopping.payload([])), stale.handler(stale.payload([]))]);

    expect(running.inputs[0]?.checkpoint.shouldContinue()).toBe(true);
    expect(stopping.inputs[0]?.checkpoint.shouldContinue()).toBe(false);
    expect(stale.inputs[0]?.checkpoint.shouldContinue()).toBe(false);
  });

  it("no resuelve ningún offset por su cuenta: eso es del caso de uso", async () => {
    const { handler, payload, resolveOffset } = setup();

    await handler(payload([{ offset: "1", key: null, value: null }]));

    expect(resolveOffset).not.toHaveBeenCalled();
  });

  it("si el caso de uso falla, el error se propaga (kafkajs no confirma lo no resuelto y reentrega)", async () => {
    const persist: PersistTelemetryBatch = () => Promise.reject(new Error("base caída"));
    const handler = createTelemetryBatchHandler(persist);

    await expect(
      handler({
        batch: { topic: "telemetry.raw", partition: 0, messages: [] },
        resolveOffset: vi.fn(),
        heartbeat: () => Promise.resolve(),
        commitOffsetsIfNecessary: () => Promise.resolve(),
        isRunning: () => true,
        isStale: () => false,
      }),
    ).rejects.toThrow("base caída");
  });
});
