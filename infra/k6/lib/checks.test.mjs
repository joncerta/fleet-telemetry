// node --test infra/k6/lib/
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildChecks, INTERRUPTIONS, isHardInterruption } from "./checks.js";

/** Una corrida coherente: lo enviado y lo observado cuadran. */
function consistent() {
  return {
    counters: {
      sent_batches: 10,
      sent_points: 1000,
      sent_valid_unique: 800,
      sent_duplicate_other_batch: 75,
      sent_duplicate_same_batch: 25,
      sent_edge_invalid: 60,
      sent_outside_area: 40,
      sent_expected_accepted: 800 + 75 + 40,
      sent_broken_envelope: 2,
      ack_accepted: 800 + 75 + 40,
      ack_rejected: 60,
      response_400: 2,
      unexpected_errors: 0,
    },
    observed: {
      persistedRows: 800,
      persistedDistinct: 800,
      dlqSchemaDistinct: 60,
      dlqOutsideDistinct: 40,
      dlqDistinct: 100,
      dlqOtherCodes: 0,
      dlqUnattributed: 0,
      dlqUnparseable: 0,
      thresholdsFailed: 0,
      dlqRepeats: 0,
    },
  };
}

const failing = (checks) => checks.filter((item) => !item.ok).map((item) => item.name);

test("una corrida coherente y sin caos cumple todas las comprobaciones", () => {
  assert.deepEqual(failing(buildChecks(consistent())), []);
});

test("la comparación de rechazados es contra lo ENVIADO: un ACK que rechaza de menos falla", () => {
  const run = consistent();
  run.counters.ack_rejected = 59;
  assert.deepEqual(failing(buildChecks(run)), ["rejected en los ACK = fuera de esquema enviados"]);
});

test("accepted del ACK se compara contra lo enviado: un ACK que acepta de menos falla", () => {
  const run = consistent();
  run.counters.ack_accepted -= 1;
  assert.equal(failing(buildChecks(run)).length, 1);
  assert.match(failing(buildChecks(run))[0], /^accepted en los ACK/);
});

test("un envelope roto sin 400 falla, y un 400 sin envelope roto también", () => {
  const missing = consistent();
  missing.counters.response_400 = 1;
  assert.deepEqual(failing(buildChecks(missing)), ["respuestas 400 = lotes con envelope roto"]);
  const extra = consistent();
  extra.counters.response_400 = 3;
  assert.deepEqual(failing(buildChecks(extra)), ["respuestas 400 = lotes con envelope roto"]);
});

test("una pérdida (menos filas que válidos únicos) y un duplicado (filas > eventId distintos) fallan", () => {
  const lost = consistent();
  lost.observed.persistedRows = 799;
  lost.observed.persistedDistinct = 799;
  assert.deepEqual(failing(buildChecks(lost)), ["persistidos = válidos únicos enviados (cero pérdidas)"]);
  const duplicated = consistent();
  duplicated.observed.persistedRows = 801;
  assert.equal(failing(buildChecks(duplicated)).length, 2);
});

test("sin interrupción, y con restart o stop (apagado ordenado), la DLQ no puede repetir mensajes", () => {
  for (const chaos of [undefined, { action: "processor-restart" }, { action: "processor-outage" }]) {
    const run = consistent();
    run.observed.dlqRepeats = 18;
    const checks = buildChecks({ ...run, chaos, drainSeconds: 3 });
    assert.deepEqual(failing(checks), ["DLQ sin mensajes repetidos (ninguna interrupción abrupta)"], String(chaos?.action));
  }
});

test("solo processor-kill (SIGKILL) admite repetidos en la DLQ, y sigue exigiendo todo lo demás", () => {
  const run = consistent();
  run.observed.dlqRepeats = 18;
  const chaos = { action: "processor-kill" };
  assert.deepEqual(failing(buildChecks({ ...run, chaos, drainSeconds: 3 })), []);
  run.observed.dlqDistinct = 99; // un eventId de la DLQ se perdió
  assert.deepEqual(failing(buildChecks({ ...run, chaos, drainSeconds: 3 })), ["DLQ (eventId distintos) = fuera de esquema + fuera de Colombia"]);
});

test("con caos, el lag debe volver a cero dentro del plazo", () => {
  const run = consistent();
  assert.deepEqual(failing(buildChecks({ ...run, chaos: { action: "processor-kill" }, drainSeconds: 91, maxDrainSeconds: 90 })), [
    "lag a cero en 90 s o menos tras terminar la carga",
  ]);
});

test("el catálogo de interrupciones: solo kill es abrupto y una acción desconocida no relaja nada", () => {
  assert.deepEqual(Object.keys(INTERRUPTIONS).sort(), ["processor-kill", "processor-outage", "processor-restart"]);
  assert.equal(isHardInterruption("processor-kill"), true);
  assert.equal(isHardInterruption("processor-restart"), false);
  assert.equal(isHardInterruption("processor-outage"), false);
  assert.equal(isHardInterruption("otra-cosa"), false);
  assert.equal(isHardInterruption(undefined), false);
});
