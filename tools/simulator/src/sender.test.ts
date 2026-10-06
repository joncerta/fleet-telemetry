import { describe, expect, it, vi } from "vitest";
import { createSender, type FetchFn } from "./sender.js";

const TOKEN = "fdt_" + "A".repeat(43);
const POINT_ID = "11111111-1111-4111-8111-111111111111";
const input = { token: TOKEN, points: [], correlationId: "corr-1", sentAt: new Date("2026-10-06T15:00:00.000Z") };

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function senderWith(fetchFn: FetchFn) {
  let clock = 0;
  return createSender({ gatewayUrl: "http://127.0.0.1:4001", fetch: fetchFn, nowMs: () => (clock += 40), timeoutMs: 1_000 });
}

describe("createSender", () => {
  it("envía el lote con el token solo en Authorization y el correlationId, y lee el ACK", async () => {
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue(json(202, { schemaVersion: 1, accepted: [POINT_ID], rejected: [], serverTime: "2026-10-06T15:00:01.000Z" }));

    const outcome = await senderWith(fetchFn).send(input);

    expect(outcome).toMatchObject({ kind: "acked", latencyMs: 40 });
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe("http://127.0.0.1:4001/v1/telemetry/batches");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ authorization: `Bearer ${TOKEN}`, "x-correlation-id": "corr-1" });
    const body = init?.body;
    if (typeof body !== "string") throw new Error("el cuerpo debe ser JSON en texto");
    expect(JSON.parse(body)).toEqual({ schemaVersion: 1, sentAt: "2026-10-06T15:00:00.000Z", points: [] });
    expect(body).not.toContain(TOKEN);
  });

  it("interpreta un ACK de una versión posterior con un motivo desconocido (esquema tolerante)", async () => {
    const ack = {
      schemaVersion: 2,
      accepted: [],
      rejected: [{ index: 0, eventId: POINT_ID, reason: "motivo_nuevo", detail: "x" }],
      serverTime: "2026-10-06T15:00:01.000Z",
    };

    const outcome = await senderWith(vi.fn<FetchFn>().mockResolvedValue(json(202, ack))).send(input);

    expect(outcome.kind).toBe("acked");
    if (outcome.kind === "acked") expect(outcome.ack.rejected[0]?.reason).toBe("unknown");
  });

  it.each([429, 500, 503])("un %i se reintenta", async (status) => {
    const outcome = await senderWith(vi.fn<FetchFn>().mockResolvedValue(json(status, { error: { code: "x", message: "x" } }))).send(input);

    expect(outcome).toMatchObject({ kind: "retry", status });
  });

  it.each([400, 401, 413])("un %i es permanente", async (status) => {
    const outcome = await senderWith(vi.fn<FetchFn>().mockResolvedValue(json(status, { error: { code: "x", message: "x" } }))).send(input);

    expect(outcome).toMatchObject({ kind: "permanent", status });
  });

  it("un fallo de red o un ACK ilegible se reintentan, sin lanzar", async () => {
    expect(await senderWith(vi.fn<FetchFn>().mockRejectedValue(new Error("ECONNREFUSED"))).send(input)).toMatchObject({ kind: "retry", status: null });
    expect(await senderWith(vi.fn<FetchFn>().mockResolvedValue(json(202, { nada: true }))).send(input)).toMatchObject({ kind: "retry", status: 202 });
  });
});
