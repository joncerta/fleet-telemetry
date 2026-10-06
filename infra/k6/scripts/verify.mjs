// Verificación de una corrida de carga: demuestra con conteos que no se perdió ni se duplicó nada. SOLO LOCAL.
//
//   node --env-file-if-exists=.env infra/k6/scripts/verify.mjs --run <runId>
//
// Espera a que el lag del grupo del processor sobre telemetry.raw sea cero y compara, por corrida (prefijo de eventId):
//   1. persistidos (SQL con fleet_ro, tenant de carga y rango de tiempo) = válidos únicos enviados; filas = eventId distintos;
//   2. `rejected` de los ACK = puntos fuera de esquema enviados;
//   3. mensajes de telemetry.dlq (eventId distintos) = fuera de esquema (invalid_schema) + fuera de Colombia (outside_operating_area);
//   4. respuestas 400 = lotes con envelope roto; y ninguno de ellos llega a la DLQ (no hay mensajes del tenant sin atribuir).
// Entradas: infra/k6/.run/<runId>.run.json (la deja run.mjs) e infra/k6/.run/<runId>.k6.json (la deja load.js).
// Sin endpoint público de conteo (decisión aprobada 6): SQL de solo lectura y lectura directa de la DLQ.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { contracts, createKafkaClient, LOAD_TENANT_ID, platform, requireEnv, RUN_DIR, sleep } from "./common.mjs";
import { hash32 } from "../lib/prng.js";

const RAW_TOPIC = "telemetry.raw";
const DLQ_TOPIC = "telemetry.dlq";
const STABLE_POLLS = 3;

/** Lag total del grupo sobre telemetry.raw (mensajes publicados y todavía no confirmados). */
async function groupLag(admin, groupId) {
  const ends = await admin.fetchTopicOffsets(RAW_TOPIC);
  const committed = await admin.fetchOffsets({ groupId, topics: [RAW_TOPIC] });
  const byPartition = new Map((committed.find((item) => item.topic === RAW_TOPIC)?.partitions ?? []).map((p) => [p.partition, Number(p.offset)]));
  let lag = 0;
  for (const { partition, offset, low } of ends) {
    const done = byPartition.get(partition) ?? -1;
    lag += Number(offset) - Math.max(done, Number(low));
  }
  return lag;
}

/** Espera lag cero estable. Devuelve los segundos que tardó, o lanza si se agota el tiempo. */
export async function waitForZeroLag(admin, groupId, timeoutMs) {
  const started = Date.now();
  let stable = 0;
  let last = Number.NaN;
  while (Date.now() - started < timeoutMs) {
    last = await groupLag(admin, groupId);
    stable = last === 0 ? stable + 1 : 0;
    if (stable >= STABLE_POLLS) return (Date.now() - started) / 1000;
    await sleep(1_000);
  }
  throw new Error(`El lag del grupo ${groupId} no llegó a cero en ${timeoutMs / 1000} s (último lag: ${last}).`);
}

/** Lee telemetry.dlq desde la hora de inicio de la corrida y devuelve los mensajes ya validados con el contrato tolerante. */
async function readDlq(kafka, admin, sinceMs, runId) {
  const ends = await admin.fetchTopicOffsets(DLQ_TOPIC);
  const starts = await admin.fetchTopicOffsetsByTimestamp(DLQ_TOPIC, sinceMs);
  const startOf = new Map(starts.map((item) => [item.partition, Number(item.offset)]));
  const pending = new Map();
  for (const { partition, offset } of ends) {
    const from = startOf.get(partition) ?? -1;
    const to = Number(offset);
    // offset -1: ningún mensaje desde esa hora. from >= to: nada que leer.
    if (from >= 0 && from < to) pending.set(partition, { from, last: to - 1 });
  }
  const messages = [];
  const unparseable = [];
  if (pending.size === 0) return { messages, unparseable };

  const groupId = `k6-verify-${runId}-${Date.now().toString(36)}`;
  const consumer = platform.createConsumer(kafka, { groupId });
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  try {
    await consumer.connect();
    await consumer.subscribe({ topic: DLQ_TOPIC, fromBeginning: true });
    await consumer.run({
      eachMessage: async ({ partition, message }) => {
        const range = pending.get(partition);
        if (range === undefined) return;
        const offset = Number(message.offset);
        if (offset >= range.from) {
          try {
            const parsed = contracts.telemetryDlqMessageTolerantSchema.safeParse(JSON.parse(message.value?.toString("utf8") ?? "null"));
            if (parsed.success) messages.push(parsed.data);
            else unparseable.push({ partition, offset });
          } catch {
            unparseable.push({ partition, offset });
          }
        }
        if (offset >= range.last) {
          pending.delete(partition);
          if (pending.size === 0) resolveDone();
        }
      },
    });
    // `seek` solo es válido tras `run`: salta al primer mensaje de la corrida en cada partición.
    for (const [partition, range] of pending) consumer.seek({ topic: DLQ_TOPIC, partition, offset: String(range.from) });
    await Promise.race([done, sleep(60_000).then(() => Promise.reject(new Error("No se pudo leer la DLQ completa en 60 s.")))]);
  } finally {
    await consumer.disconnect().catch(() => undefined);
    await admin.deleteGroups([groupId]).catch(() => undefined);
  }
  return { messages, unparseable };
}

function distinct(items) {
  return new Set(items).size;
}

/**
 * Compara conteos. Devuelve `{ ok, checks, report }`. `chaos` relaja una sola cosa y lo declara: con una interrupción, la DLQ puede repetir
 * mensajes (at-least-once, ADR-005.3) y se exige igualdad por eventId distinto en vez de por mensaje.
 */
export async function verifyRun({ runId, t0Ms, k6, chaos, lagTimeoutMs = 120_000, maxDrainSeconds = 90 }) {
  const groupId = process.env.PROCESSOR_CONSUMER_GROUP || "processor";
  const runTag = hash32("run", runId);
  const prefix = `${(runTag >>> 0).toString(16).padStart(8, "0")}-`;
  const c = k6.counters;

  const kafka = createKafkaClient("k6-verify");
  const admin = platform.createAdmin(kafka);
  const pool = platform.createPool({
    connectionString: requireEnv("DATABASE_RO_URL"),
    applicationName: "k6-verify",
    logger: { error: (...args) => process.stderr.write(`${JSON.stringify(args[0]?.err?.message ?? "error")}\n`) },
    max: 2,
  });
  try {
    await admin.connect();
    const drainSeconds = await waitForZeroLag(admin, groupId, lagTimeoutMs);

    // Rango de tiempo obligatorio en hypertables: los puntos de la corrida van de t0 - 36 h (ráfagas offline) a t0 + 1 h.
    const from = new Date(t0Ms - 48 * 3_600_000).toISOString();
    const to = new Date(t0Ms + 3_600_000).toISOString();
    const persisted = await pool.query(
      "SELECT count(*)::int AS rows, count(DISTINCT event_id)::int AS distinct_events FROM telemetry WHERE tenant_id = $1 AND recorded_at >= $2::timestamptz AND recorded_at < $3::timestamptz AND event_id::text LIKE $4",
      [LOAD_TENANT_ID, from, to, `${prefix}%`],
    );
    const { rows: persistedRows, distinct_events: persistedDistinct } = persisted.rows[0];

    const dlq = await readDlq(kafka, admin, t0Ms - 60_000, runId);
    const ofTenant = dlq.messages.filter((m) => m.tenantId === LOAD_TENANT_ID);
    const ofRun = ofTenant.filter((m) => m.eventId !== null && m.eventId.startsWith(prefix));
    const unattributed = ofTenant.length - ofRun.length;
    const codeOf = (code) => ofRun.filter((m) => m.reason.code === code);
    const schemaMessages = codeOf("invalid_schema");
    const outsideMessages = codeOf("outside_operating_area");
    const otherCodes = ofRun.length - schemaMessages.length - outsideMessages.length;
    const dlqDistinct = distinct(ofRun.map((m) => m.eventId));
    const dlqRepeats = ofRun.length - dlqDistinct;

    const checks = [];
    const add = (name, expected, observed, extra = {}) => checks.push({ name, expected, observed, ok: expected === observed, ...extra });
    add("persistidos = válidos únicos enviados (cero pérdidas)", c.sent_valid_unique, persistedRows);
    add("filas persistidas = eventId distintos (cero duplicados)", persistedRows, persistedDistinct);
    add("rejected en los ACK = fuera de esquema enviados", c.sent_edge_invalid, c.ack_rejected);
    add("DLQ invalid_schema (eventId distintos) = fuera de esquema enviados", c.sent_edge_invalid, distinct(schemaMessages.map((m) => m.eventId)));
    add("DLQ outside_operating_area (eventId distintos) = fuera de Colombia enviados", c.sent_outside_area, distinct(outsideMessages.map((m) => m.eventId)));
    add("DLQ (eventId distintos) = fuera de esquema + fuera de Colombia", c.sent_edge_invalid + c.sent_outside_area, dlqDistinct);
    add("DLQ sin otros códigos de fallo", 0, otherCodes);
    add("respuestas 400 = lotes con envelope roto", c.sent_broken_envelope, c.response_400);
    add("ningún mensaje del tenant en la DLQ sin atribuir a la corrida (los envelopes rotos no llegan a la DLQ)", 0, unattributed);
    add("mensajes ilegibles en la DLQ", 0, dlq.unparseable.length);
    add("errores inesperados en k6", 0, c.unexpected_errors);
    add("thresholds de k6 fallidos", 0, k6.thresholdsFailed.length);
    if (chaos) {
      checks.push({ name: `lag a cero en ${maxDrainSeconds} s o menos tras terminar la carga`, expected: `<= ${maxDrainSeconds}`, observed: drainSeconds, ok: drainSeconds <= maxDrainSeconds });
      // Sin caos, la DLQ no debe repetir mensajes; con caos se admite y se informa (ADR-005.3).
    } else {
      add("DLQ sin mensajes repetidos (sin interrupciones)", 0, dlqRepeats);
    }

    const report = {
      runId,
      prefix,
      groupId,
      drainSeconds,
      sent: {
        batches: c.sent_batches,
        points: c.sent_points,
        validUnique: c.sent_valid_unique,
        duplicateOtherBatch: c.sent_duplicate_other_batch,
        duplicateSameBatch: c.sent_duplicate_same_batch,
        edgeInvalid: c.sent_edge_invalid,
        outsideArea: c.sent_outside_area,
        brokenEnvelope: c.sent_broken_envelope,
      },
      observed: { persistedRows, persistedDistinct, ackRejected: c.ack_rejected, response400: c.response_400, dlqMessages: ofRun.length, dlqDistinct, dlqRepeats, dlqUnattributed: unattributed },
      chaos: chaos ?? null,
      checks,
    };
    return { ok: checks.every((item) => item.ok), checks, report };
  } finally {
    await admin.disconnect().catch(() => undefined);
    await pool.end().catch(() => undefined);
  }
}

export function printReport({ checks, report }) {
  const p = report.sent;
  const duplicates = p.duplicateOtherBatch + p.duplicateSameBatch;
  const rate = (n) => (p.points === 0 ? "0" : ((100 * n) / p.points).toFixed(1));
  const lines = [
    `Verificación de la corrida ${report.runId} (grupo ${report.groupId}, lag a cero en ${report.drainSeconds.toFixed(1)} s)`,
    `  lotes ${p.batches}, puntos ${p.points}: válidos únicos ${p.validUnique}, duplicados ${duplicates} (${rate(duplicates)} %; ${p.duplicateOtherBatch} en otro lote y ${p.duplicateSameBatch} en el mismo), ` +
      `fuera de esquema ${p.edgeInvalid} (${rate(p.edgeInvalid)} %), fuera de Colombia ${p.outsideArea} (${rate(p.outsideArea)} %); lotes con envelope roto ${p.brokenEnvelope}`,
    `  persistidos ${report.observed.persistedRows}; DLQ ${report.observed.dlqMessages} mensajes (${report.observed.dlqDistinct} eventId distintos, ${report.observed.dlqRepeats} repetidos)`,
    ...checks.map((item) => `  [${item.ok ? "OK" : "FALLA"}] ${item.name}: esperado ${item.expected}, observado ${item.observed}`),
    checks.every((item) => item.ok) ? "RESULTADO: OK" : "RESULTADO: FALLA",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

// CLI: `verify.mjs --run <runId>`
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const index = process.argv.indexOf("--run");
  const runId = index === -1 ? undefined : process.argv[index + 1];
  if (runId === undefined) {
    process.stderr.write("Uso: verify.mjs --run <runId>\n");
    process.exit(2);
  }
  try {
    const run = JSON.parse(readFileSync(path.join(RUN_DIR, `${runId}.run.json`), "utf8"));
    const k6 = JSON.parse(readFileSync(path.join(RUN_DIR, `${runId}.k6.json`), "utf8"));
    const result = await verifyRun({ runId, t0Ms: run.t0Ms, k6, chaos: run.chaos });
    writeFileSync(path.join(RUN_DIR, `${runId}.verify.json`), JSON.stringify(result.report, null, 2));
    printReport(result);
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`verify falló: ${error instanceof Error ? error.message : "error desconocido"}\n`);
    process.exitCode = 1;
  }
}
