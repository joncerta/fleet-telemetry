import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_BATCH_BYTES, MESSAGE_OVERHEAD_BYTES, splitBySize } from "./batching.js";
import type { FleetMessage } from "./producer.js";

const message = (n: number, valueBytes: number): FleetMessage => ({
  key: `k${n}`,
  value: "x".repeat(valueBytes),
  headers: { correlationId: "corr" },
});
const footprint = (messages: readonly FleetMessage[]) => messages.reduce((total, m) => total + Buffer.byteLength(String(m.value)) + MESSAGE_OVERHEAD_BYTES, 0);

describe("splitBySize", () => {
  it("sin mensajes no devuelve grupos", () => {
    expect(splitBySize([], 1_000)).toEqual([]);
  });

  it("un lote que cabe va en un solo grupo", () => {
    const messages = [message(1, 100), message(2, 100)];

    expect(splitBySize(messages, 10_000)).toEqual([messages]);
  });

  it("parte en grupos consecutivos que no superan el tope y conserva el orden", () => {
    const messages = Array.from({ length: 10 }, (_, i) => message(i, 100));

    const groups = splitBySize(messages, 3 * (100 + MESSAGE_OVERHEAD_BYTES));

    expect(groups.map((group) => group.length)).toEqual([3, 3, 3, 1]);
    expect(groups.flat()).toEqual(messages);
    for (const group of groups) expect(footprint(group)).toBeLessThanOrEqual(3 * (100 + MESSAGE_OVERHEAD_BYTES));
  });

  it("un mensaje mayor que el tope va solo, sin perder los demás", () => {
    const small = message(1, 10);
    const huge = message(2, 5_000);
    const other = message(3, 10);

    expect(splitBySize([small, huge, other], 1_000)).toEqual([[small], [huge], [other]]);
  });

  it("cuenta los bytes UTF-8 y no los caracteres", () => {
    const accented: FleetMessage = { key: "k", value: "é".repeat(100), headers: { correlationId: "corr" } };

    // 100 caracteres = 200 bytes: con un tope de 2 mensajes de 100 bytes + overhead no caben dos.
    expect(splitBySize([accented, accented], 2 * (100 + MESSAGE_OVERHEAD_BYTES))).toHaveLength(2);
  });

  it("el tope por defecto es la mitad de 1 MiB", () => {
    expect(DEFAULT_MAX_BATCH_BYTES).toBe(512 * 1024);
    const messages = Array.from({ length: 1_500 }, (_, i) => message(i, 900));

    const groups = splitBySize(messages);

    expect(groups.length).toBeGreaterThan(1);
    for (const group of groups) expect(footprint(group)).toBeLessThanOrEqual(DEFAULT_MAX_BATCH_BYTES);
  });
});
