import { describe, expect, it } from "vitest";
import { ack, acceptAll, http, makePoint, setup, uuid } from "./test-helpers";

async function enqueue(ctx: ReturnType<typeof setup>, n: number, from = 1): Promise<string[]> {
  const ids: string[] = [];
  for (let i = from; i < from + n; i++) {
    ctx.clock.now += 1;
    await ctx.outbox.enqueue(makePoint(i));
    ids.push(uuid(i));
  }
  return ids;
}

describe("escritura antes del envío", () => {
  it("el punto queda en la cola (pending) sin que exista ningún envío", async () => {
    const ctx = setup();
    await enqueue(ctx, 1);
    expect(ctx.transport.sentBatches).toHaveLength(0);
    expect(await ctx.store.counts()).toMatchObject({ pending: 1, inFlight: 0 });
  });

  it("encolar dos veces el mismo eventId no duplica", async () => {
    const ctx = setup();
    await ctx.outbox.enqueue(makePoint(1));
    await ctx.outbox.enqueue(makePoint(1));
    expect((await ctx.store.counts()).pending).toBe(1);
  });
});

describe("ACK", () => {
  it("parcial: borra solo lo aceptado, mueve lo rechazado a su tabla y deja lo ausente en pending", async () => {
    const ctx = setup();
    const [a, b, c] = await enqueue(ctx, 3);
    ctx.transport.push(http(202, ack([a!], [{ eventId: b!, reason: "invalid_schema" }])));

    const result = await ctx.engine.drain();

    expect(result.outcome).toBe("backoff");
    expect(result).toMatchObject({ sent: 1, rejected: 1 });
    expect(await ctx.store.counts()).toMatchObject({ pending: 1, inFlight: 0, rejected: 1, sent: 1 });
    expect([...ctx.store.rows.keys()]).toEqual([c]);
    expect(await ctx.store.rejectedByReason()).toEqual({ invalid_schema: 1 });
  });

  it("un motivo desconocido del servidor se lee como unknown y es un rechazo permanente", async () => {
    const ctx = setup();
    const [a] = await enqueue(ctx, 1);
    ctx.transport.push(http(202, ack([], [{ eventId: a!, reason: "motivo_del_futuro" }])));

    await ctx.engine.drain();

    expect(await ctx.store.rejectedByReason()).toEqual({ unknown: 1 });
    expect((await ctx.store.counts()).pending).toBe(0);
    expect(ctx.transport.sentBatches).toHaveLength(1);
  });

  it("una schemaVersion futura del ACK se lee (no se reintenta para siempre)", async () => {
    const ctx = setup();
    const [a] = await enqueue(ctx, 1);
    ctx.transport.push(http(202, { ...ack([a!]), schemaVersion: 7, campoNuevo: true }));

    const result = await ctx.engine.drain();

    expect(result.outcome).toBe("drained");
    expect((await ctx.store.counts()).pending).toBe(0);
  });

  it("los eventId ajenos al lote que vienen en el ACK se ignoran", async () => {
    const ctx = setup();
    const [a] = await enqueue(ctx, 1);
    // Un punto capturado después de reclamarse el lote no está en él: el ACK no puede borrarlo.
    ctx.transport.push((body) => {
      void ctx.outbox.enqueue(makePoint(99));
      return http(202, ack([...body.points.map((p) => (p as { eventId: string }).eventId), uuid(99)]));
    });

    const result = await ctx.engine.drain({ maxBatches: 1 });

    expect(result.sent).toBe(1);
    expect(a).toBeDefined();
    expect(ctx.store.rows.has(uuid(99))).toBe(true);
  });

  it("un ACK que no pasa el schema no borra nada y se registra el error", async () => {
    const ctx = setup();
    await enqueue(ctx, 2);
    ctx.transport.push(http(202, { accepted: "todo" }));

    const result = await ctx.engine.drain();

    expect(result.outcome).toBe("backoff");
    expect(await ctx.store.counts()).toMatchObject({ pending: 2, inFlight: 0, sent: 0 });
    expect(await ctx.store.getMeta("lastError")).toBe("ack_invalid");
  });

  it("202 con cuerpo vacío no borra nada", async () => {
    const ctx = setup();
    await enqueue(ctx, 1);
    ctx.transport.push(http(202, undefined));
    await ctx.engine.drain();
    expect((await ctx.store.counts()).pending).toBe(1);
  });

  it("un rechazo sin eventId se ubica por index dentro del lote", async () => {
    const ctx = setup();
    const [a, b] = await enqueue(ctx, 2);
    ctx.transport.push(
      http(202, {
        schemaVersion: 1,
        accepted: [a!],
        rejected: [{ index: 1, eventId: null, reason: "invalid_schema" }],
        serverTime: "2026-10-05T12:00:00.000Z",
      }),
    );
    await ctx.engine.drain();
    expect(await ctx.store.counts()).toMatchObject({ pending: 0, rejected: 1, sent: 1 });
    expect(ctx.store.rejectedRows[0]?.eventId).toBe(b);
  });

  it("guarda la hora del servidor y el desfase de reloj del último ACK", async () => {
    const ctx = setup();
    await enqueue(ctx, 1);
    ctx.transport.push(acceptAll);
    await ctx.engine.drain();
    expect(await ctx.store.getMeta("lastServerTime")).toBe("2026-10-05T12:00:00.000Z");
    expect(await ctx.store.getMeta("lastSyncAt")).not.toBeNull();
    expect(await ctx.store.getMeta("lastClockSkewMs")).not.toBeNull();
  });
});

describe("fallos transitorios: nada se borra", () => {
  it.each([
    ["500", http(500)],
    ["503 con Retry-After", http(503, undefined, "5")],
    ["error de red", new Error("Network request failed")],
    ["timeout", Object.assign(new Error("aborted"), { name: "TimeoutError" })],
    ["404 inesperado", http(404)],
  ])("%s", async (_name, step) => {
    const ctx = setup();
    await enqueue(ctx, 3);
    ctx.transport.push(step);

    const result = await ctx.engine.drain();

    expect(result.outcome).toBe("backoff");
    expect(await ctx.store.counts()).toMatchObject({ pending: 3, inFlight: 0, sent: 0, rejected: 0, dead: 0 });
    expect(result.nextAttemptAt).toBeGreaterThan(ctx.clock.now);
  });

  it("respuesta perdida tras un envío exitoso: el reenvío lleva los mismos eventId y el back lo acepta", async () => {
    const ctx = setup();
    const ids = await enqueue(ctx, 3);
    // El servidor persistió, pero la respuesta nunca llegó.
    ctx.transport.push(new Error("Network request failed"));
    await ctx.engine.drain();

    ctx.clock.now += 120_000;
    ctx.transport.push(acceptAll);
    const retry = await ctx.engine.drain();

    expect(ctx.transport.sentBatches).toEqual([ids, ids]);
    expect(retry.outcome).toBe("drained");
    expect((await ctx.store.counts()).pending).toBe(0);
  });

  it("no reintenta mientras dure el backoff, pero force lo salta", async () => {
    const ctx = setup();
    await enqueue(ctx, 1);
    ctx.transport.push(http(500));
    await ctx.engine.drain();

    const blocked = await ctx.engine.drain();
    expect(blocked.outcome).toBe("backoff");
    expect(ctx.transport.sentBatches).toHaveLength(1);

    ctx.transport.push(acceptAll);
    const forced = await ctx.engine.drain({ force: true });
    expect(forced.outcome).toBe("drained");
  });

  it("tras un envío exitoso el backoff se reinicia", async () => {
    const ctx = setup();
    await enqueue(ctx, 1);
    ctx.transport.push(http(500));
    await ctx.engine.drain();
    expect(await ctx.store.getMeta("backoffAttempt")).toBe("1");

    ctx.transport.push(acceptAll);
    await ctx.engine.drain({ force: true });
    expect(await ctx.store.getMeta("backoffAttempt")).toBe("0");
    expect(await ctx.store.getMeta("nextAttemptAt")).toBeNull();
  });
});

describe("429 y Retry-After", () => {
  it("espera al menos Retry-After y ni force lo salta", async () => {
    const ctx = setup();
    await enqueue(ctx, 1);
    ctx.transport.push(http(429, undefined, "120"));

    const first = await ctx.engine.drain();
    expect(first.nextAttemptAt).toBeGreaterThanOrEqual(ctx.clock.now + 120_000);
    expect(await ctx.store.counts()).toMatchObject({ pending: 1 });

    ctx.clock.now += 60_000;
    const forced = await ctx.engine.drain({ force: true });
    expect(forced.outcome).toBe("backoff");
    expect(ctx.transport.sentBatches).toHaveLength(1);

    ctx.clock.now += 61_000;
    ctx.transport.push(acceptAll);
    expect((await ctx.engine.drain()).outcome).toBe("drained");
  });
});

describe("400, 401/403 y 413", () => {
  it("400: el lote va a dead con el motivo y no se reintenta en bucle", async () => {
    const ctx = setup();
    await enqueue(ctx, 2);
    ctx.transport.push(http(400, { error: { code: "invalid_envelope", message: "x" } }));

    const result = await ctx.engine.drain();

    expect(result.outcome).toBe("paused");
    expect(await ctx.store.counts()).toMatchObject({ pending: 0, dead: 1 });
    expect(ctx.store.deadRows[0]?.reason).toBe("http_400:invalid_envelope");
    expect(ctx.transport.sentBatches).toHaveLength(1);
  });

  it("400 sistemático: con 3 lotes en cola, solo 1 va a dead, 2 quedan pending y el envío se pausa", async () => {
    const ctx = setup({ maxBatchPoints: 1 });
    await enqueue(ctx, 3);
    ctx.transport.push(http(400, { error: { code: "invalid_envelope", message: "x" } }));
    ctx.transport.push(http(400, { error: { code: "invalid_envelope", message: "x" } }));

    const result = await ctx.engine.drain();

    expect(result.outcome).toBe("paused");
    expect(await ctx.store.counts()).toMatchObject({ pending: 2, inFlight: 0, dead: 1 });
    expect(ctx.transport.sentBatches).toHaveLength(1);
    expect(await ctx.store.getMeta("syncPausedReason")).toBe("client_error");

    // Pausado: ni force ni nuevos drain envían.
    expect((await ctx.engine.drain({ force: true })).outcome).toBe("paused");
    expect(ctx.transport.sentBatches).toHaveLength(1);
  });

  it("la pausa por 400 se levanta con resume() o al cambiar la versión de la app, no antes", async () => {
    const ctx = setup({ maxBatchPoints: 1 });
    await enqueue(ctx, 2);
    await ctx.engine.onAppVersion("1.0.0");
    ctx.transport.push(http(400));
    await ctx.engine.drain();

    expect(await ctx.engine.onAppVersion("1.0.0")).toBe(false);
    expect(await ctx.store.getMeta("syncPausedReason")).toBe("client_error");

    expect(await ctx.engine.onAppVersion("1.0.1")).toBe(true);
    expect(await ctx.store.getMeta("syncPausedReason")).toBeNull();
    ctx.transport.push(acceptAll);
    expect((await ctx.engine.drain()).outcome).toBe("drained");
  });

  it.each([401, 403])("%i: pausa el sync, no borra nada y pide token", async (status) => {
    const ctx = setup();
    await enqueue(ctx, 2);
    ctx.transport.push(http(status));

    const result = await ctx.engine.drain();
    expect(result.outcome).toBe("paused");
    expect(await ctx.store.counts()).toMatchObject({ pending: 2, inFlight: 0 });
    expect(await ctx.store.getMeta("syncPausedReason")).toBe("unauthorized");

    // Pausado: ni siquiera `force` envía.
    const again = await ctx.engine.drain({ force: true });
    expect(again.outcome).toBe("paused");
    expect(ctx.transport.sentBatches).toHaveLength(1);

    await ctx.engine.resume();
    ctx.transport.push(acceptAll);
    expect((await ctx.engine.drain()).outcome).toBe("drained");
  });

  it("sin token: pausa sin hacer ningún request", async () => {
    const ctx = setup({ token: null });
    await enqueue(ctx, 1);
    const result = await ctx.engine.drain();
    expect(result.outcome).toBe("paused");
    expect(ctx.transport.sentBatches).toHaveLength(0);
    // "unlinked" se deduce de las credenciales: no se persiste (no hay pausa que levantar al vincular).
    expect(await ctx.store.getMeta("syncPausedReason")).toBeNull();
  });

  it("401: manda un lote de prueba cada N minutos; con 202 se reanuda solo", async () => {
    const ctx = setup();
    await enqueue(ctx, 2);
    ctx.transport.push(http(401));
    await ctx.engine.drain();
    expect(await ctx.store.getMeta("syncPausedAt")).not.toBeNull();

    // Antes del intervalo no prueba.
    ctx.clock.now += 4 * 60_000;
    expect((await ctx.engine.drain()).outcome).toBe("paused");
    expect(ctx.transport.sentBatches).toHaveLength(1);

    // Vence el intervalo y el token sigue inválido: un solo lote de prueba y vuelve a esperar.
    ctx.clock.now += 61_000;
    ctx.transport.push(http(401));
    expect((await ctx.engine.drain()).outcome).toBe("paused");
    expect(ctx.transport.sentBatches).toHaveLength(2);
    ctx.clock.now += 60_000;
    expect((await ctx.engine.drain()).outcome).toBe("paused");
    expect(ctx.transport.sentBatches).toHaveLength(2);

    // Token válido de nuevo (revocación levantada): con 202 se reanuda y drena.
    ctx.clock.now += 5 * 60_000;
    ctx.transport.push(acceptAll);
    expect((await ctx.engine.drain()).outcome).toBe("drained");
    expect(await ctx.store.getMeta("syncPausedReason")).toBeNull();
    expect(await ctx.store.getMeta("syncPausedAt")).toBeNull();
    expect((await ctx.store.counts()).pending).toBe(0);
  });

  it("una prueba exitosa tras un 401 levanta la pausa y sigue drenando el resto", async () => {
    const ctx = setup({ maxBatchPoints: 1 });
    await enqueue(ctx, 3);
    ctx.transport.push(http(401));
    await ctx.engine.drain();
    ctx.clock.now += 6 * 60_000;
    ctx.transport.push(acceptAll);
    ctx.transport.push(acceptAll);
    ctx.transport.push(acceptAll);
    const probe = await ctx.engine.drain();
    expect(probe.outcome).toBe("drained");
    expect(ctx.transport.sentBatches).toHaveLength(4);
    expect(await ctx.store.getMeta("syncPausedReason")).toBeNull();
  });

  it("413: parte el lote a la mitad y reintenta", async () => {
    const ctx = setup();
    const ids = await enqueue(ctx, 4);
    ctx.transport.push(http(413));
    ctx.transport.push(acceptAll);
    ctx.transport.push(acceptAll);

    const result = await ctx.engine.drain();

    expect(ctx.transport.sentBatches).toEqual([ids, ids.slice(0, 2), ids.slice(2)]);
    expect(result.outcome).toBe("drained");
    expect((await ctx.store.counts()).sent).toBe(4);
  });

  it("413 con un solo punto: a dead, no en bucle", async () => {
    const ctx = setup();
    await enqueue(ctx, 1);
    ctx.transport.push(http(413));
    await ctx.engine.drain();
    expect(await ctx.store.counts()).toMatchObject({ pending: 0, dead: 1 });
  });
});

describe("lotes", () => {
  it("nunca un request por punto: drena en lotes del máximo, en orden de captura", async () => {
    const ctx = setup({ maxBatchPoints: 200 });
    const ids = await enqueue(ctx, 450);
    for (let i = 0; i < 3; i++) ctx.transport.push(acceptAll);

    const result = await ctx.engine.drain();

    expect(ctx.transport.sentBatches.map((b) => b.length)).toEqual([200, 200, 50]);
    expect(ctx.transport.sentBatches.flat()).toEqual(ids);
    expect(result).toMatchObject({ outcome: "drained", sent: 450, batches: 3 });
  });

  it("respeta el tope de bytes del lote", async () => {
    const ctx = setup();
    await enqueue(ctx, 10);
    const size = JSON.stringify(makePoint(1)).length;
    const claimed = await ctx.store.claim(200, size * 3 + 1, ctx.clock.now);
    expect(claimed).toHaveLength(3);
  });

  it("maxBatches corta el drenaje y avisa que queda cola", async () => {
    const ctx = setup({ maxBatchPoints: 2 });
    await enqueue(ctx, 5);
    ctx.transport.push(acceptAll);
    ctx.transport.push(acceptAll);
    const result = await ctx.engine.drain({ maxBatches: 2 });
    expect(result.outcome).toBe("more_pending");
    expect((await ctx.store.counts()).pending).toBe(1);
  });
});

describe("lease y concurrencia", () => {
  it("app muerta con un lote in_flight: vuelve a pending tras el lease", async () => {
    const ctx = setup();
    await enqueue(ctx, 3);
    // Un proceso reclamó el lote y murió.
    await ctx.store.claim(200, 1e6, ctx.clock.now);
    expect(await ctx.store.counts()).toMatchObject({ pending: 0, inFlight: 3 });

    // Antes del lease no se toca.
    ctx.clock.now += 59_000;
    expect(await ctx.store.reclaimExpired(ctx.clock.now, 60_000)).toBe(0);

    ctx.clock.now += 2_000;
    ctx.transport.push(acceptAll);
    const result = await ctx.engine.drain();

    expect(result).toMatchObject({ outcome: "drained", sent: 3 });
  });

  it("dos claims concurrentes no toman los mismos puntos", async () => {
    const ctx = setup();
    await enqueue(ctx, 10);
    const [a, b] = await Promise.all([ctx.store.claim(6, 1e6, ctx.clock.now), ctx.store.claim(6, 1e6, ctx.clock.now)]);
    const idsA = a.map((e) => e.eventId);
    const idsB = b.map((e) => e.eventId);
    expect(idsA.filter((id) => idsB.includes(id))).toEqual([]);
    expect(idsA.length + idsB.length).toBe(10);
  });

  it("dos drain simultáneos en el mismo proceso: el segundo responde busy y no envía nada", async () => {
    const ctx = setup();
    await enqueue(ctx, 3);
    ctx.transport.push(acceptAll);
    const [first, second] = await Promise.all([ctx.engine.drain(), ctx.engine.drain()]);
    expect([first.outcome, second.outcome].sort()).toEqual(["busy", "drained"]);
    expect(ctx.transport.sentBatches).toHaveLength(1);
  });

  it("un payload ilegible va a dead y no bloquea al resto", async () => {
    const ctx = setup();
    const [a, b] = await enqueue(ctx, 2);
    ctx.store.rows.get(a!)!.payload = "{no es json";
    ctx.transport.push(acceptAll);

    const result = await ctx.engine.drain();

    expect(result.outcome).toBe("drained");
    expect(ctx.transport.sentBatches).toEqual([[b]]);
    expect(await ctx.store.counts()).toMatchObject({ dead: 1, pending: 0, sent: 1 });
  });
});

describe("tope y purga", () => {
  it("al superar el tope descarta los pending más viejos, los cuenta y avisa", async () => {
    const ctx = setup({ cap: 5 });
    await enqueue(ctx, 8);

    expect(await ctx.store.counts()).toMatchObject({ pending: 5, discarded: 3 });
    expect([...ctx.store.rows.keys()]).toEqual([4, 5, 6, 7, 8].map(uuid));
    expect(ctx.discards).toEqual([1, 1, 1]);
  });

  it("no descarta lo que está en vuelo", async () => {
    const ctx = setup({ cap: 3 });
    await enqueue(ctx, 3);
    await ctx.store.claim(3, 1e6, ctx.clock.now);
    await enqueue(ctx, 2, 10);
    // 3 in_flight + 2 nuevos = 5 > 3; solo se pueden descartar los pending.
    expect((await ctx.store.counts()).inFlight).toBe(3);
    expect((await ctx.store.counts()).discarded).toBe(2);
  });
});
