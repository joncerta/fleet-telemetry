// Carga de la ingesta (modelo ABIERTO: dispositivos que envían a ritmo fijo, sin esperar a la respuesta anterior).
// Solo local: aborta si el objetivo no es localhost. Se lanza con `node infra/k6/scripts/run.mjs` (que fija la corrida, ejecuta
// el caos opcional y verifica los conteos); k6 solo cuenta lo que envía y lo que responde el ACK.
//
// Variables (-e NOMBRE=valor):
//   BASE_URL      objetivo, por defecto http://localhost:4001 (solo hosts locales)
//   RUN_ID        identificador de la corrida (fija el prefijo de los eventId); por defecto "adhoc"
//   SEED          semilla de la generación; por defecto 42
//   PROFILE       "smoke" (por defecto) o "load"
//   RATE          lotes por segundo del tráfico normal (smoke 20, load 40)
//   DURATION      duración del tráfico normal en smoke (por defecto 30s)
//   BURST_RATE    lotes por segundo de la ráfaga offline (por defecto 2)
//   VEHICLES      vehículos a usar de infra/k6/.run/tokens.json (por defecto todos)
//   TOKENS_FILE   ruta del archivo de tokens (por defecto ./.run/tokens.json)
//   T0_MS         instante de referencia de los timestamps; por defecto, el de `setup()`

import { check } from "k6";
import exec from "k6/execution";
import http from "k6/http";
import { Counter, Trend } from "k6/metrics";
import { buildBatch, locate, makeContext, NAMESPACES } from "./lib/model.js";
import { hash32 } from "./lib/prng.js";

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]", "::1", "host.docker.internal"];
const BASE_URL = (__ENV.BASE_URL || "http://localhost:4001").replace(/\/+$/, "");
const hostname = BASE_URL.replace(/^[a-z]+:\/\//i, "").split(/[/:?#]/)[0];
if (!LOCAL_HOSTS.includes(hostname.toLowerCase())) {
  throw new Error(`Este script solo corre contra un objetivo local (${LOCAL_HOSTS.join(", ")}), no contra "${hostname}".`);
}

const RUN_ID = __ENV.RUN_ID || "adhoc";
const SEED = Number(__ENV.SEED || 42);
const PROFILE = __ENV.PROFILE || "smoke";
const RATE = Number(__ENV.RATE || (PROFILE === "load" ? 40 : 20));
const BURST_RATE = Number(__ENV.BURST_RATE || 2);
const DURATION = __ENV.DURATION || "30s";
const RUN_TAG = hash32("run", RUN_ID);
const TOKENS_FILE = __ENV.TOKENS_FILE || "./.run/tokens.json";
const OUTPUT_FILE = __ENV.SUMMARY_FILE || `./.run/${RUN_ID}.k6.json`;

// Se lee en la fase init (una vez por VU). Los tokens solo se usan como header: nunca se imprimen.
const tokenFile = JSON.parse(open(TOKENS_FILE));
const fleet = tokenFile.vehicles.slice(0, Number(__ENV.VEHICLES || tokenFile.vehicles.length));
const vehicleIds = fleet.map((entry) => entry.vehicleId);

// Contadores por categoría (lo que se ENVIÓ y fue respondido con 202) y lo que dijo el ACK.
const sentBatches = new Counter("sent_batches");
const sentPoints = new Counter("sent_points");
const sentValidUnique = new Counter("sent_valid_unique");
const sentDuplicateOtherBatch = new Counter("sent_duplicate_other_batch");
const sentDuplicateSameBatch = new Counter("sent_duplicate_same_batch");
const sentEdgeInvalid = new Counter("sent_edge_invalid");
const sentOutsideArea = new Counter("sent_outside_area");
const sentBrokenEnvelope = new Counter("sent_broken_envelope");
const ackAccepted = new Counter("ack_accepted");
const ackRejected = new Counter("ack_rejected");
const response400 = new Counter("response_400");
const unexpectedErrors = new Counter("unexpected_errors");
const steadyLatency = new Trend("ingest_steady_latency", true);
const burstLatency = new Trend("ingest_burst_latency", true);

const scenarios =
  PROFILE === "load"
    ? {
        steady: {
          executor: "ramping-arrival-rate",
          exec: "ingest",
          startRate: Math.max(1, Math.floor(RATE / 4)),
          timeUnit: "1s",
          preAllocatedVUs: 100,
          maxVUs: 400,
          stages: [
            { target: RATE, duration: "30s" },
            { target: RATE, duration: __ENV.DURATION || "3m" },
            { target: RATE * 2, duration: "30s" },
            { target: RATE * 2, duration: "30s" },
            { target: RATE, duration: "30s" },
          ],
        },
        burst: {
          executor: "constant-arrival-rate",
          exec: "ingest",
          rate: BURST_RATE,
          timeUnit: "1s",
          duration: "20s",
          startTime: "1m30s",
          preAllocatedVUs: 60,
          maxVUs: 200,
        },
      }
    : {
        steady: {
          executor: "constant-arrival-rate",
          exec: "ingest",
          rate: RATE,
          timeUnit: "1s",
          duration: DURATION,
          preAllocatedVUs: 60,
          maxVUs: 200,
        },
        // Muchos vehículos recuperan señal a la vez: lotes grandes con puntos de horas atrás.
        burst: {
          executor: "constant-arrival-rate",
          exec: "ingest",
          rate: BURST_RATE,
          timeUnit: "1s",
          duration: "8s",
          startTime: "10s",
          preAllocatedVUs: 40,
          maxVUs: 100,
        },
      };

export const options = {
  scenarios,
  thresholds: {
    // Cualquier respuesta fuera de lo esperado (202 con ACK correcto, o 400 en envelopes rotos) rompe la corrida.
    unexpected_errors: ["count==0"],
    // Un modelo abierto que no alcanza a lanzar las llegadas indica saturación.
    dropped_iterations: ["count==0"],
    "checks{category:ack}": ["rate==1"],
    "checks{category:accepted}": ["rate==1"],
    "checks{category:rejected}": ["rate==1"],
    "checks{category:broken_envelope}": ["rate==1"],
    // Latencia del ingest (p95/p99). Los lotes de ráfaga son hasta 25 veces mayores: su umbral es propio.
    ingest_steady_latency: ["p(95)<400", "p(99)<1000"],
    ingest_burst_latency: ["p(95)<2000", "p(99)<4000"],
  },
  summaryTrendStats: ["avg", "med", "p(90)", "p(95)", "p(99)", "max"],
};

export function setup() {
  return { t0Ms: Number(__ENV.T0_MS) || Date.now() };
}

let cachedContext;
function contextFor(data) {
  cachedContext ??= makeContext({ seed: SEED, runTag: RUN_TAG, t0Ms: data.t0Ms, vehicleIds });
  return cachedContext;
}

function sameSet(expected, actual) {
  if (expected.size !== actual.size) return false;
  for (const id of actual) if (!expected.has(id)) return false;
  return true;
}

export function ingest(data) {
  const scenario = exec.scenario.name;
  const ns = scenario === "burst" ? NAMESPACES.burst : NAMESPACES.steady;
  const latency = scenario === "burst" ? burstLatency : steadyLatency;
  const n = exec.scenario.iterationInTest;
  const { v, k } = locate(n, vehicleIds.length);
  const batch = buildBatch(contextFor(data), ns, v, k);

  const response = http.post(`${BASE_URL}/v1/telemetry/batches`, batch.body, {
    headers: {
      Authorization: `Bearer ${fleet[v].token}`,
      "Content-Type": "application/json",
      "X-Correlation-Id": `k6:${RUN_ID}:${scenario}:${n}`,
    },
    tags: { name: `ingest_${scenario}`, scenario_kind: batch.broken ? "broken_envelope" : "batch" },
    timeout: "30s",
  });
  latency.add(response.timings.duration);

  if (batch.broken) {
    const ok = check(response, { "envelope roto responde 400": (r) => r.status === 400 }, { category: "broken_envelope" });
    if (ok) {
      sentBrokenEnvelope.add(1);
      response400.add(1);
    } else {
      unexpectedErrors.add(1);
    }
    return;
  }

  let ack = null;
  if (response.status === 202) {
    try {
      ack = response.json();
    } catch (_error) {
      ack = null;
    }
  }
  const ackOk = check(
    response,
    {
      "202 con ACK v1": () => ack !== null && ack.schemaVersion === 1 && Array.isArray(ack.accepted) && Array.isArray(ack.rejected) && typeof ack.serverTime === "string",
    },
    { category: "ack" },
  );
  if (!ackOk) {
    unexpectedErrors.add(1);
    return;
  }

  const accepted = new Set(ack.accepted);
  const rejected = new Set(ack.rejected.map((item) => item.eventId));
  const acceptedOk = check(response, { "aceptados = válidos + duplicados + fuera de Colombia": () => sameSet(batch.expectedAccepted, accepted) }, { category: "accepted" });
  const rejectedOk = check(
    response,
    {
      "rechazados = inválidos de borde, con motivo invalid_schema": () =>
        sameSet(batch.expectedRejected, rejected) && ack.rejected.every((item) => item.reason === "invalid_schema"),
    },
    { category: "rejected" },
  );
  if (!acceptedOk || !rejectedOk) {
    unexpectedErrors.add(1);
    return;
  }

  const c = batch.counts;
  sentBatches.add(1);
  sentPoints.add(c.points);
  sentValidUnique.add(c.validUnique);
  sentDuplicateOtherBatch.add(c.duplicateOtherBatch);
  sentDuplicateSameBatch.add(c.duplicateSameBatch);
  sentEdgeInvalid.add(c.edgeInvalid);
  sentOutsideArea.add(c.outside);
  ackAccepted.add(ack.accepted.length);
  ackRejected.add(ack.rejected.length);
}

const COUNTERS = [
  "sent_batches",
  "sent_points",
  "sent_valid_unique",
  "sent_duplicate_other_batch",
  "sent_duplicate_same_batch",
  "sent_edge_invalid",
  "sent_outside_area",
  "sent_broken_envelope",
  "ack_accepted",
  "ack_rejected",
  "response_400",
  "unexpected_errors",
  "dropped_iterations",
  "http_reqs",
];

export function handleSummary(data) {
  const counters = {};
  for (const name of COUNTERS) counters[name] = data.metrics[name] ? data.metrics[name].values.count : 0;
  const trend = (name) => (data.metrics[name] ? data.metrics[name].values : null);
  const thresholds = {};
  for (const [metric, value] of Object.entries(data.metrics)) {
    if (value.thresholds) thresholds[metric] = value.thresholds;
  }
  const failed = Object.entries(thresholds).flatMap(([metric, results]) =>
    Object.entries(results)
      .filter(([, result]) => result.ok === false)
      .map(([expression]) => `${metric}: ${expression}`),
  );
  const result = {
    runId: RUN_ID,
    seed: SEED,
    profile: PROFILE,
    counters,
    latencyMs: { steady: trend("ingest_steady_latency"), burst: trend("ingest_burst_latency") },
    thresholds,
    thresholdsFailed: failed,
    testRunDurationMs: data.state.testRunDurationMs,
  };
  const lines = [
    `k6 ${RUN_ID} (${PROFILE}, semilla ${SEED}): ${counters.http_reqs} peticiones en ${(data.state.testRunDurationMs / 1000).toFixed(1)} s`,
    ...COUNTERS.filter((name) => name !== "http_reqs").map((name) => `  ${name.padEnd(28)} ${counters[name]}`),
    ...["steady", "burst"].map((name) => {
      const t = result.latencyMs[name];
      return t ? `  latencia ${name}: p95 ${t["p(95)"].toFixed(0)} ms, p99 ${t["p(99)"].toFixed(0)} ms, max ${t.max.toFixed(0)} ms` : `  latencia ${name}: sin datos`;
    }),
    failed.length === 0 ? "  thresholds: todos cumplidos" : `  thresholds FALLIDOS: ${failed.join("; ")}`,
    "",
  ];
  return { stdout: lines.join("\n"), [OUTPUT_FILE]: JSON.stringify(result, null, 2) };
}
