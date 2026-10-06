import { devicePairRequestSchema } from "@fleet/contracts";
import { describe, expect, it, vi } from "vitest";
import { createPairTransport } from "../infra/http-transport";
import { filterPairingInput, normalizePairingCode, pairDevice, type PairTransport } from "./pairing";
import { http } from "./test-helpers";

const TOKEN = `fdt_${"A".repeat(43)}`;
const VEHICLE = "11111111-1111-4111-8111-111111111111";
const created = http(201, { deviceToken: TOKEN, vehicleId: VEHICLE, plate: "NRT101", pairedAt: "2026-10-05T12:00:00.000Z" });

function run(response: ReturnType<typeof http> | Error, rawCode = "abcd 2345") {
  const save = vi.fn(() => Promise.resolve());
  const onPaired = vi.fn(() => Promise.resolve());
  const bodies: unknown[] = [];
  const transport: PairTransport = {
    pair: (body) => {
      bodies.push(body);
      return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
    },
  };
  const result = pairDevice({ rawCode, transport, credentials: { save }, onPaired, nowMs: 0 });
  return { result, save, onPaired, bodies };
}

describe("pairDevice", () => {
  it("201: normaliza el código, valida la petición y guarda token y vehicleId (sin la placa)", async () => {
    const { result, save, onPaired, bodies } = run(created);
    expect(await result).toEqual({ ok: true });
    expect(bodies).toEqual([{ code: "ABCD2345" }]);
    expect(devicePairRequestSchema.safeParse(bodies[0]).success).toBe(true);
    expect(save).toHaveBeenCalledWith({ token: TOKEN, vehicleId: VEHICLE });
    expect(JSON.stringify(save.mock.calls)).not.toContain("NRT101");
    expect(onPaired).toHaveBeenCalledOnce();
  });

  it("un código mal formado no llega a la red", async () => {
    for (const raw of ["", "ABC", "ABCD234I", "ABCD23456"]) {
      const { result, bodies } = run(created, raw);
      expect(await result).toEqual({ ok: false, error: "code_format" });
      expect(bodies).toHaveLength(0);
    }
  });

  it.each([400, 404])("%i: código inválido, usado o vencido", async (status) => {
    const { result, save } = run(http(status, { error: { code: "invalid_pairing_code", message: "x" } }));
    expect(await result).toEqual({ ok: false, error: "invalid_code" });
    expect(save).not.toHaveBeenCalled();
  });

  it("429: respeta Retry-After", async () => {
    const { result } = run(http(429, undefined, "30"));
    expect(await result).toEqual({ ok: false, error: "rate_limited", retryAfterMs: 30_000 });
  });

  it("429 sin Retry-After, 5xx, red caída y respuesta inválida no guardan nada", async () => {
    for (const [response, error] of [
      [http(429), "rate_limited"],
      [http(503), "server"],
      [new Error("x"), "network"],
      [http(201, { deviceToken: "sin-prefijo" }), "bad_response"],
      [http(201, undefined), "bad_response"],
    ] as const) {
      const { result, save } = run(response);
      expect(await result).toMatchObject({ ok: false, error });
      expect(save).not.toHaveBeenCalled();
    }
  });

  it("una URL mal configurada se reporta como config", async () => {
    const boom = Object.assign(new Error("x"), { name: "EndpointConfigError" });
    expect(await run(boom).result).toEqual({ ok: false, error: "config" });
  });

  it("un token de formato futuro (tolerante) se acepta", async () => {
    const { result, save } = run(http(201, { deviceToken: "fdt_formato-nuevo", vehicleId: VEHICLE, plate: "X", pairedAt: "2026-10-05T12:00:00.000Z" }));
    expect(await result).toEqual({ ok: true });
    expect(save).toHaveBeenCalled();
  });
});

describe("código de vinculación", () => {
  it("normaliza y filtra lo tecleado", () => {
    expect(normalizePairingCode(" ab-cd 23 ")).toBe("ABCD23");
    expect(filterPairingInput("abcd-0o1i2345xyz", 8)).toBe("ABCD2345");
  });
});

describe("createPairTransport", () => {
  it("hace POST a /v1/devices/pair con el código y sin Authorization", async () => {
    const fetchImpl = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify({ ok: 1 }), { status: 201, headers: { "retry-after": "5" } })),
    );
    const t = createPairTransport({ baseUrl: () => "http://10.0.2.2:4002/", fetchImpl: fetchImpl as unknown as typeof fetch });
    const res = await t.pair({ code: "ABCD2345" });
    expect(res).toEqual({ status: 201, body: { ok: 1 }, retryAfterHeader: "5" });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://10.0.2.2:4002/v1/devices/pair");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ code: "ABCD2345" }));
    expect(JSON.stringify(init?.headers)).not.toMatch(/authorization/i);
  });

  it("un fallo de red se lanza como NetworkError sin el mensaje original", async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error("Network request failed http://secreto")));
    const t = createPairTransport({ baseUrl: () => "http://x", fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(t.pair({ code: "ABCD2345" })).rejects.toMatchObject({ name: "NetworkError", message: "network" });
  });
});
