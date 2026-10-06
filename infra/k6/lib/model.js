// Modelo de datos de la carga: funciones puras (sin I/O, sin estado) que, dada la semilla y la posición (espacio, vehículo,
// lote, punto), devuelven siempre el mismo evento. Corre en k6 (load.js) y en Node (model.test.mjs).
//
// Mezcla por punto (infra/CLAUDE.md, regla 7 de CLAUDE.md):
//   10 % duplicados reales  (mismo eventId y mismo payload; 25 % en el mismo lote, el resto en un lote anterior)
//    3 % inválidos de borde (no cumplen el esquema: van a `rejected` del ACK y a telemetry.dlq)
//    2 % inválidos de procesamiento (fuera de Colombia: el gateway los acepta y el processor los manda a la DLQ)
// y, además, 2 % de los LOTES con envelope roto (400, sin DLQ).
//
// Un token autentica a UN vehículo, así que cada lote lleva puntos de un solo vehículo.

import { hash32, rngFrom, uuidWithTag } from "./prng.js";

export const KIND = Object.freeze({
  VALID: "valid",
  DUPLICATE: "duplicate",
  EDGE_INVALID: "edge_invalid",
  OUTSIDE: "outside",
});

export const MIX = Object.freeze({ edgeInvalid: 0.03, outside: 0.02, duplicate: 0.1 });
export const BROKEN_ENVELOPE_RATE = 0.02;
/** Fracción de lotes cuyos puntos llegan desordenados (reconexiones, reintentos). */
export const OUT_OF_ORDER_RATE = 0.15;
const SAME_BATCH_DUPLICATE_SHARE = 0.25;

const HOUR_MS = 3_600_000;

/**
 * Espacios de lotes. `steady`: lotes pequeños de tráfico normal. `burst`: lotes grandes de dispositivos que recuperan señal
 * tras estar offline (sus puntos son de horas atrás). Cada espacio tiene su propio rango de tiempo y su propio stride, así que
 * sus eventId no chocan entre sí. Los puntos más viejos quedan a menos de 7 días (límite del gateway) y ninguno en el futuro:
 * el avance de un vehículo es (lotes por vehículo x stride x stepMs), mucho menor que `baseOffsetMs` en corridas de minutos.
 */
export const NAMESPACES = Object.freeze({
  steady: { id: "s", stride: 20, minPoints: 5, maxPoints: 20, baseOffsetMs: 12 * HOUR_MS, stepMs: 2_000 },
  burst: { id: "b", stride: 500, minPoints: 200, maxPoints: 500, baseOffsetMs: 36 * HOUR_MS, stepMs: 1_000 },
});

// Ciudades dentro del área de operación (lon, lat; regla 13 de CLAUDE.md) y puntos fuera de Colombia.
const CITIES = [
  [-74.07, 4.71], // Bogotá
  [-75.57, 6.25], // Medellín
  [-76.53, 3.45], // Cali
  [-74.78, 10.96], // Barranquilla
  [-73.12, 7.12], // Bucaramanga
];
const OUTSIDE_COLOMBIA = [
  [-80.19, 25.76], // Miami
  [-77.04, -12.05], // Lima
  [-99.13, 19.43], // Ciudad de México
];

const r6 = (n) => Math.round(n * 1e6) / 1e6;

/** ctx = { seed, runTag, t0Ms, vehicleIds }. */
export function makeContext({ seed, runTag, t0Ms, vehicleIds }) {
  return { seed, runTag: runTag >>> 0, t0Ms, vehicleIds };
}

function rng(ctx, ...parts) {
  return rngFrom(hash32(ctx.seed, ...parts));
}

export function isBroken(ctx, ns, v, k) {
  return rng(ctx, "broken", ns.id, v, k)() < BROKEN_ENVELOPE_RATE;
}

export function sizeOf(ctx, ns, v, k) {
  const r = rng(ctx, "size", ns.id, v, k)();
  return ns.minPoints + Math.floor(r * (ns.maxPoints - ns.minPoints + 1));
}

/** Tipo "crudo" del punto: sin resolver de dónde sale un duplicado. */
function rawKind(ctx, ns, v, k, i) {
  const r = rng(ctx, "kind", ns.id, v, k, i)();
  if (r < MIX.edgeInvalid) return KIND.EDGE_INVALID;
  if (r < MIX.edgeInvalid + MIX.outside) return KIND.OUTSIDE;
  if (r < MIX.edgeInvalid + MIX.outside + MIX.duplicate) return KIND.DUPLICATE;
  return KIND.VALID;
}

/**
 * Resuelve un punto: `{ kind, origin: { k, i } }`. Un duplicado apunta a un punto VÁLIDO anterior (de un lote anterior del
 * mismo vehículo que no sea de envelope roto, o de un índice menor del mismo lote). Si no hay origen disponible, es válido.
 */
export function resolveSlot(ctx, ns, v, k, i) {
  const kind = rawKind(ctx, ns, v, k, i);
  if (kind !== KIND.DUPLICATE) return { kind, origin: { k, i } };

  const pick = rng(ctx, "dup", ns.id, v, k, i);
  const sameBatch = i > 0 && (k === 0 || pick() < SAME_BATCH_DUPLICATE_SHARE);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (sameBatch) {
      const j = Math.floor(pick() * i);
      if (rawKind(ctx, ns, v, k, j) === KIND.VALID) return { kind, origin: { k, i: j }, sameBatch: true };
    } else if (k > 0) {
      const back = 1 + Math.floor(pick() * Math.min(3, k));
      const kk = k - back;
      if (isBroken(ctx, ns, v, kk)) continue;
      const j = Math.floor(pick() * sizeOf(ctx, ns, v, kk));
      if (rawKind(ctx, ns, v, kk, j) === KIND.VALID) return { kind, origin: { k: kk, i: j }, sameBatch: false };
    }
  }
  return { kind: KIND.VALID, origin: { k, i } };
}

export function eventIdOf(ctx, ns, v, k, i) {
  return uuidWithTag(ctx.runTag, rng(ctx, "id", ns.id, v, k, i));
}

function pointAt(ctx, ns, v, k, i) {
  const r = rng(ctx, "pt", ns.id, v, k, i);
  const seq = k * ns.stride + i;
  const [lon0, lat0] = CITIES[v % CITIES.length];
  const angle = seq / 37 + v;
  const recordedMs = ctx.t0Ms - ns.baseOffsetMs + seq * ns.stepMs + Math.floor(r() * (ns.stepMs / 2));
  return {
    eventId: eventIdOf(ctx, ns, v, k, i),
    vehicleId: ctx.vehicleIds[v],
    recordedAt: new Date(recordedMs).toISOString(),
    lon: r6(lon0 + Math.sin(angle) * 0.02 + (r() - 0.5) * 0.001),
    lat: r6(lat0 + Math.cos(angle) * 0.02 + (r() - 0.5) * 0.001),
    speedMps: r6(r() * 30),
    headingDeg: r6(r() * 359.9),
    accuracyM: r6(3 + r() * 10),
    altitudeM: Math.round(2_000 + r() * 600),
    mocked: false,
    lowAccuracy: false,
  };
}

function edgeInvalidPoint(ctx, ns, v, k, i) {
  const point = pointAt(ctx, ns, v, k, i);
  const variant = Math.floor(rng(ctx, "edge", ns.id, v, k, i)() * 4);
  if (variant === 0) point.lat = 95; // fuera de [-90, 90]
  else if (variant === 1) point.speedMps = -5; // velocidad negativa
  else if (variant === 2) point.recordedAt = "no-es-una-fecha";
  else point.mocked = "si"; // no es booleano
  return point;
}

function outsidePoint(ctx, ns, v, k, i) {
  const point = pointAt(ctx, ns, v, k, i);
  const [lon, lat] = OUTSIDE_COLOMBIA[Math.floor(rng(ctx, "out", ns.id, v, k, i)() * OUTSIDE_COLOMBIA.length)];
  point.lon = lon;
  point.lat = lat;
  return point;
}

function brokenBody(ctx, ns, v, k, sentAt) {
  const variant = Math.floor(rng(ctx, "brokenvariant", ns.id, v, k)() * 6);
  switch (variant) {
    case 0:
      return `{"schemaVersion":1,"sentAt":"${sentAt}","points":[{"eventId":`; // JSON truncado
    case 1:
      return JSON.stringify({ schemaVersion: 1, sentAt }); // sin points
    case 2:
      return JSON.stringify({ schemaVersion: 1, sentAt, points: [] }); // lote vacío
    case 3:
      return JSON.stringify({ schemaVersion: 1, sentAt, points: "no-es-un-arreglo" });
    case 4:
      return JSON.stringify({ schemaVersion: 1, sentAt, points: new Array(501).fill(1) }); // más de MAX_BATCH_POINTS
    default:
      return JSON.stringify({ schemaVersion: 2, sentAt, points: [] }); // versión de envelope desconocida
  }
}

function shuffle(items, random) {
  const copy = items.slice();
  for (let n = copy.length - 1; n > 0; n -= 1) {
    const m = Math.floor(random() * (n + 1));
    [copy[n], copy[m]] = [copy[m], copy[n]];
  }
  return copy;
}

/**
 * Lote `k` del vehículo `v` en el espacio `ns`. Devuelve el cuerpo a enviar y lo que se espera del ACK:
 * - `broken`: envelope roto, se espera 400 y nada más;
 * - `counts`: puntos por categoría (válidos únicos, duplicados dentro y fuera del lote, inválidos de borde, fuera de Colombia);
 * - `expectedAccepted`: eventId distintos que el ACK debe devolver en `accepted` (válidos, duplicados y fuera de Colombia);
 * - `expectedRejected`: eventId que el ACK debe devolver en `rejected` (los inválidos de borde).
 */
export function buildBatch(ctx, ns, v, k, sentAt = new Date().toISOString()) {
  if (isBroken(ctx, ns, v, k)) {
    return { broken: true, vehicleIndex: v, body: brokenBody(ctx, ns, v, k, sentAt) };
  }
  const size = sizeOf(ctx, ns, v, k);
  const counts = { points: size, validUnique: 0, duplicateSameBatch: 0, duplicateOtherBatch: 0, edgeInvalid: 0, outside: 0 };
  const expectedAccepted = new Set();
  const expectedRejected = new Set();
  let points = [];

  for (let i = 0; i < size; i += 1) {
    const slot = resolveSlot(ctx, ns, v, k, i);
    if (slot.kind === KIND.VALID) {
      counts.validUnique += 1;
      const point = pointAt(ctx, ns, v, k, i);
      expectedAccepted.add(point.eventId);
      points.push(point);
    } else if (slot.kind === KIND.DUPLICATE) {
      // Mismo eventId y mismo payload que el original: se regenera desde la identidad del origen.
      const point = pointAt(ctx, ns, v, slot.origin.k, slot.origin.i);
      if (slot.sameBatch) counts.duplicateSameBatch += 1;
      else counts.duplicateOtherBatch += 1;
      expectedAccepted.add(point.eventId);
      points.push(point);
    } else if (slot.kind === KIND.EDGE_INVALID) {
      counts.edgeInvalid += 1;
      const point = edgeInvalidPoint(ctx, ns, v, k, i);
      expectedRejected.add(point.eventId);
      points.push(point);
    } else {
      counts.outside += 1;
      const point = outsidePoint(ctx, ns, v, k, i);
      expectedAccepted.add(point.eventId);
      points.push(point);
    }
  }

  if (rng(ctx, "order", ns.id, v, k)() < OUT_OF_ORDER_RATE) {
    points = shuffle(points, rng(ctx, "shuffle", ns.id, v, k));
  }
  return {
    broken: false,
    vehicleIndex: v,
    body: JSON.stringify({ schemaVersion: 1, sentAt, points }),
    counts,
    expectedAccepted,
    expectedRejected,
  };
}

/** Vehículo y número de lote de la llamada global `n` (0, 1, 2...). Reparte los lotes en ronda sobre los vehículos. */
export function locate(n, vehicleCount) {
  return { v: n % vehicleCount, k: Math.floor(n / vehicleCount) };
}
