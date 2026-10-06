// Pruebas del generador de datos de la carga. Se corren con `node --test infra/k6/lib/` (sin dependencias).
import assert from "node:assert/strict";
import { test } from "node:test";
import { BROKEN_ENVELOPE_RATE, buildBatch, KIND, locate, makeContext, MIX, NAMESPACES, resolveSlot } from "./model.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VEHICLES = 300;
const vehicleIds = Array.from({ length: VEHICLES }, (_, n) => `f1ee7000-0000-4000-9000-${String(0xf0000 + n + 1).padStart(12, "0")}`);
const T0 = Date.UTC(2026, 9, 5, 12, 0, 0);
const ctx = makeContext({ seed: 42, runTag: 0xabcdef12, t0Ms: T0, vehicleIds });
const SENT_AT = "2026-10-05T12:00:00.000Z";

function* batches(ns, total) {
  for (let n = 0; n < total; n += 1) {
    const { v, k } = locate(n, VEHICLES);
    yield { v, k, batch: buildBatch(ctx, ns, v, k, SENT_AT) };
  }
}

test("es determinista: mismo contexto y misma posición dan el mismo lote", () => {
  const again = makeContext({ seed: 42, runTag: 0xabcdef12, t0Ms: T0, vehicleIds });
  for (const [v, k] of [[0, 0], [17, 3], [299, 9]]) {
    assert.equal(buildBatch(ctx, NAMESPACES.steady, v, k, SENT_AT).body, buildBatch(again, NAMESPACES.steady, v, k, SENT_AT).body);
  }
  const other = makeContext({ seed: 43, runTag: 0xabcdef12, t0Ms: T0, vehicleIds });
  assert.notEqual(buildBatch(ctx, NAMESPACES.steady, 5, 2, SENT_AT).body, buildBatch(other, NAMESPACES.steady, 5, 2, SENT_AT).body);
});

test("la mezcla observada se acerca a la configurada (10 % duplicados, 5 % inválidos, 2 % envelopes rotos)", () => {
  let points = 0;
  let duplicates = 0;
  let edge = 0;
  let outside = 0;
  let broken = 0;
  let total = 0;
  for (const { batch } of batches(NAMESPACES.steady, 6000)) {
    total += 1;
    if (batch.broken) {
      broken += 1;
      continue;
    }
    points += batch.counts.points;
    duplicates += batch.counts.duplicateSameBatch + batch.counts.duplicateOtherBatch;
    edge += batch.counts.edgeInvalid;
    outside += batch.counts.outside;
  }
  const near = (observed, expected, tolerance) => assert.ok(Math.abs(observed - expected) <= tolerance, `${observed} vs ${expected}`);
  near(duplicates / points, MIX.duplicate, 0.01);
  near(edge / points, MIX.edgeInvalid, 0.005);
  near(outside / points, MIX.outside, 0.005);
  near(broken / total, BROKEN_ENVELOPE_RATE, 0.006);
});

test("un duplicado repite eventId y payload de un punto válido que se envió antes, nunca de un lote roto", () => {
  const sent = new Map(); // eventId -> JSON del punto
  const duplicated = [];
  for (const { v, k, batch } of batches(NAMESPACES.steady, 3000)) {
    if (batch.broken) continue;
    for (const point of JSON.parse(batch.body).points) {
      const key = JSON.stringify(point);
      if (sent.has(point.eventId)) duplicated.push({ id: point.eventId, same: sent.get(point.eventId) === key, v, k });
      else sent.set(point.eventId, key);
    }
  }
  assert.ok(duplicated.length > 1000);
  assert.ok(duplicated.every((d) => d.same), "un duplicado debe tener exactamente el mismo payload");
});

test("los eventId son uuid v4 válidos con el prefijo de la corrida; los inválidos de borde conservan su uuid", () => {
  for (const { batch } of batches(NAMESPACES.steady, 300)) {
    if (batch.broken) continue;
    for (const point of JSON.parse(batch.body).points) {
      assert.match(point.eventId, UUID);
      assert.ok(point.eventId.startsWith("abcdef12-"));
    }
    for (const id of batch.expectedRejected) assert.match(id, UUID);
  }
});

test("el ACK esperado separa aceptados y rechazados, y los fuera de Colombia son válidos de esquema", () => {
  for (const { batch } of batches(NAMESPACES.steady, 300)) {
    if (batch.broken) continue;
    const points = JSON.parse(batch.body).points;
    const ids = new Set(points.map((p) => p.eventId));
    assert.equal(ids.size, batch.expectedAccepted.size + batch.expectedRejected.size);
    for (const id of batch.expectedRejected) assert.ok(!batch.expectedAccepted.has(id));
    const c = batch.counts;
    assert.equal(c.points, c.validUnique + c.duplicateSameBatch + c.duplicateOtherBatch + c.edgeInvalid + c.outside);
    assert.equal(batch.expectedAccepted.size, c.validUnique + c.outside + c.duplicateOtherBatch);
  }
});

test("los puntos válidos están en Colombia, el vehículo es el del lote y nada queda en el futuro", () => {
  for (const { v, batch } of batches(NAMESPACES.burst, 40)) {
    if (batch.broken) continue;
    for (const p of JSON.parse(batch.body).points) {
      assert.equal(p.vehicleId, vehicleIds[v]);
      if (!batch.expectedRejected.has(p.eventId) && p.lat >= -4.3 && p.lat <= 13.6) {
        assert.ok(p.lon >= -82 && p.lon <= -66.8);
      }
      if (typeof p.recordedAt === "string" && !Number.isNaN(Date.parse(p.recordedAt))) assert.ok(Date.parse(p.recordedAt) < T0);
    }
  }
});

test("los lotes de ráfaga son grandes, de hasta 500 puntos", () => {
  let max = 0;
  for (const { batch } of batches(NAMESPACES.burst, 100)) if (!batch.broken) max = Math.max(max, batch.counts.points);
  assert.ok(max >= 400 && max <= 500);
});

test("el primer lote de un vehículo no tiene duplicados de otro lote", () => {
  for (let i = 0; i < NAMESPACES.steady.maxPoints; i += 1) {
    const slot = resolveSlot(ctx, NAMESPACES.steady, 3, 0, i);
    if (slot.kind === KIND.DUPLICATE) assert.equal(slot.sameBatch, true);
  }
});
