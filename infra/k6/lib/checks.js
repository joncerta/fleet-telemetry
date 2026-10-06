// Comprobaciones de la verificación de una corrida y catálogo de interrupciones del caos. Funciones puras (sin I/O): las usan
// verify.mjs y chaos.mjs, y checks.test.mjs las prueba.
//
// Contadores de k6 (`c`), con dos orígenes que NO se derivan uno del otro:
//   - `sent_*`: lo que el script CONSTRUYÓ y envió (se cuenta al enviar, antes de mirar la respuesta);
//   - `ack_accepted`, `ack_rejected`, `response_400`: lo que RESPONDIÓ el gateway (se cuenta de la respuesta, antes de las
//     comprobaciones por lote).
// Si ambos lados se alimentaran de la misma variable, comparar `sent_edge_invalid` con `ack_rejected` sería una tautología.

/**
 * Interrupciones del processor. `hard` = el proceso muere sin apagado ordenado (SIGKILL): puede caer ENTRE persistir un tramo y
 * confirmar su offset, y entonces la DLQ del tramo se republica al reentregarse (at-least-once, ADR-005.3). Con un apagado ordenado
 * (SIGTERM: `restart`, `stop`) el consumer termina el tramo y confirma antes de salir: la DLQ no debe repetir nada.
 */
export const INTERRUPTIONS = Object.freeze({
  "processor-restart": Object.freeze({ hard: false, description: "restart (SIGTERM, apagado ordenado) y arranque" }),
  "processor-outage": Object.freeze({ hard: false, description: "stop (SIGTERM), 10 s de espera y start" }),
  "processor-kill": Object.freeze({ hard: true, description: "kill -s SIGKILL, 5 s de espera y start" }),
});

/** `true` si la acción de caos mata el proceso sin apagado ordenado (se admiten repetidos en la DLQ). */
export function isHardInterruption(action) {
  return action !== undefined && action !== null && INTERRUPTIONS[action]?.hard === true;
}

/**
 * Comparaciones de conteos. `observed` sale de la base y de la DLQ; `drainSeconds`, del tiempo hasta lag cero.
 * Devuelve la lista `{ name, expected, observed, ok }`.
 */
export function buildChecks({ counters: c, observed, chaos, drainSeconds, maxDrainSeconds = 90 }) {
  const checks = [];
  const add = (name, expected, actual) => checks.push({ name, expected, observed: actual, ok: expected === actual });

  add("persistidos = válidos únicos enviados (cero pérdidas)", c.sent_valid_unique, observed.persistedRows);
  add("filas persistidas = eventId distintos (cero duplicados)", observed.persistedRows, observed.persistedDistinct);
  add("rejected en los ACK = fuera de esquema enviados", c.sent_edge_invalid, c.ack_rejected);
  // El generador calcula el conjunto esperado por lote al construirlo (eventId distintos: dos duplicados del mismo origen cuentan uno).
  add("accepted en los ACK = eventId distintos aceptables enviados (válidos, duplicados y fuera de Colombia)", c.sent_expected_accepted, c.ack_accepted);
  add("DLQ invalid_schema (eventId distintos) = fuera de esquema enviados", c.sent_edge_invalid, observed.dlqSchemaDistinct);
  add("DLQ outside_operating_area (eventId distintos) = fuera de Colombia enviados", c.sent_outside_area, observed.dlqOutsideDistinct);
  add("DLQ (eventId distintos) = fuera de esquema + fuera de Colombia", c.sent_edge_invalid + c.sent_outside_area, observed.dlqDistinct);
  add("DLQ sin otros códigos de fallo", 0, observed.dlqOtherCodes);
  add("respuestas 400 = lotes con envelope roto", c.sent_broken_envelope, c.response_400);
  add("ningún mensaje del tenant en la DLQ sin atribuir a la corrida (los envelopes rotos no llegan a la DLQ)", 0, observed.dlqUnattributed);
  add("mensajes ilegibles en la DLQ", 0, observed.dlqUnparseable);
  add("errores inesperados en k6", 0, c.unexpected_errors);
  add("thresholds de k6 fallidos", 0, observed.thresholdsFailed);

  if (chaos) {
    checks.push({
      name: `lag a cero en ${maxDrainSeconds} s o menos tras terminar la carga`,
      expected: `<= ${maxDrainSeconds}`,
      observed: drainSeconds,
      ok: drainSeconds <= maxDrainSeconds,
    });
  }
  // Sin interrupción o con una interrupción ORDENADA (restart, stop) la DLQ no repite mensajes. Solo un kill (SIGKILL) lo admite.
  if (!isHardInterruption(chaos?.action)) {
    add("DLQ sin mensajes repetidos (ninguna interrupción abrupta)", 0, observed.dlqRepeats);
  }
  return checks;
}
