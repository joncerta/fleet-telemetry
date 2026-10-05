# Registro de auditoría de IA

Correcciones reales a sugerencias deficientes de la IA durante el desarrollo: qué propuso, por qué falla, cómo se corrigió y qué evita que vuelva a pasar. Cada entrada se registra con `/ai-audit-entry`, a pedido del humano.

### 1. La prueba de ida y vuelta de migraciones no cubría el esquema y la documentación afirmaba que sí
**Fecha:** 2026-10-05 · **Área:** packages/platform (migraciones) y entorno agéntico (`CLAUDE.md`) · **Severidad:** alta · **Detectado por:** architect-reviewer
**Tipo de error de IA:** test que no prueba nada · otro: documentación que afirma una cobertura que el test no tiene

**Contexto / prompt original**
> Orquestador a `backend-engineer`, al pedirle las migraciones reversibles: "Ida y vuelta de TODAS las migraciones reales de `infra/db/migrations/` […] Después del segundo up: el mismo estado que tras el primero (como mínimo, extensiones, roles con sus privilegios y las filas de control). Este test hace que cada migración futura quede probada como reversible automáticamente."
>
> La afirmación salió del propio prompt del orquestador, que después la copió a `CLAUDE.md`.

**Lo que propuso la IA** — `CLAUDE.md:87` (orquestador). El fragmento del snapshot en `packages/platform/src/migrations/rollback.int.test.ts:361-383` (backend-engineer) es TODO: se corrigió antes del commit y no quedó en el historial.
```markdown
- El test de integración del runner hace up → down → up de todas las migraciones. Una migración nueva queda probada sin escribir nada extra.
```
Según el revisor, el snapshot solo comparaba extensiones, roles, grants de base y de esquema, privilegios por defecto y filas de control.

**Por qué es deficiente**
En la fase 1, una `004_x.sql` que haga `ALTER TABLE vehicle_state ALTER COLUMN tenant_id SET NOT NULL` con down `SELECT 1;` pasaría: el down no falla, el segundo up es idempotente, el snapshot sale igual y el CI queda en verde. Como `CLAUDE.md` decía que no hacía falta nada extra, los subagentes no escribirían el test que falta, y el down incompleto llegaría a producción.

**Criterio aplicado y prompt correctivo**
> "B. El alto: ida y vuelta que no cubre el esquema. Amplía el snapshot: relaciones […], columnas de `public` (tipo, nulabilidad, default), constraints (`pg_get_constraintdef`) e índices (`indexdef`), grants por tabla de `fleet_app` y `fleet_ro`, hypertables y jobs de Timescale […]. Toma un baseline antes del primer up y exige que el estado después del down completo sea igual al baseline […]. Demuestra que el test detecta un down incompleto."
>
> El orquestador corrigió `CLAUDE.md` a mano. Una segunda revisión encontró que la primera corrección todavía indexaba los pasos por número de versión (falso negativo con huecos en la numeración), y también se corrigió.

**Resultado** — `packages/platform/src/migrations/rollback.int.test.ts:546-553`
```ts
// `states[i]` es el estado previo al up de `files[i]`: se indexa por posición, no por número de versión (001, 003, 004...).
for (const { file, before } of files.map((file, i) => ({ file, before: states[i] })).reverse()) {
  const result = await back(work, { steps: 1 });
  expect(result.reverted).toEqual([{ version: file.version, name: file.name }]);
  expect(await snapshot(), `estado tras revertir ${file.downFileName}`).toEqual(before);
}
expect(await controlRows()).toEqual([]);
expect(await snapshot(), "estado tras el down completo contra el baseline").toEqual(baseline);
```

**Prevención:**
- `rollback.int.test.ts`, en "el test de ida y vuelta detecta un down incompleto": pares incompletos que deben fallar (tabla, columna, índice, grant, función, privilegio por defecto, enum y hueco de numeración).
- `CLAUDE.md` ahora remite a ADR-003 para la cobertura real.
- Pendiente: definiciones de vistas y funciones (H2, fase 1d), y la frase "prueba el down automáticamente" de `.claude/skills/new-usecase/SKILL.md:46`, que hay que alinear.

**Estándar aplicado:** regla 17 de CLAUDE.md · migraciones reversibles · **Commit:** `1948b41` (test), `a6961b6` (CLAUDE.md)

### 2. Tests de Kafka que no probaban murmur2 ni la autocreación en el broker
**Fecha:** 2026-10-05 · **Área:** packages/platform (Kafka), tests/e2e y ADR-001 · **Severidad:** media · **Detectado por:** architect-reviewer
**Tipo de error de IA:** test que no prueba nada · otro: ADR que afirma un test inexistente
**Reincidencia de:** #1 (mismo tipo, detectado en la misma revisión)

**Contexto / prompt original**
> Orquestador a `backend-engineer` (pasos 2 y 3): "Kafka: con el producer de la fábrica, produce y consume en el tópico temporal y verifica la key y el header `correlationId`." Smoke e2e: "existen los 4 tópicos, y producir a uno inexistente falla."

**Lo que propuso la IA** — `docs/adr/001-stack.md:52` (orquestador). Los tests de `packages/platform/src/kafka/producer.int.test.ts:79-93` y del smoke e2e son TODO: se corrigieron antes del commit.
```markdown
  - los tests de integración contra Redpanda verifican el comportamiento que importa: producer idempotente con `acks=-1` y commit después de persistir.
```
Según el revisor:
- "misma key, misma partición (particionador explícito)" pasaba con cualquier particionador determinista;
- "autocreación desactivada" usaba el cliente de la fábrica, que ya fuerza `allowAutoTopicCreation: false`.

**Por qué es deficiente**
- El test del particionador pasaba incluso con `LegacyPartitioner`. No protege el orden por vehículo cuando escribe otro productor, por ejemplo uno en Java.
- El de autocreación pasaba aunque `redpanda-init` no hubiera desactivado la autocreación en el broker, que era justamente lo que decía probar.
- El ADR afirmaba tests contra Redpanda que no existían.

**Criterio aplicado y prompt correctivo**
> "Tests que no prueban lo que dicen: 1. Particionador: compara contra vectores conocidos de murmur2 de Apache Kafka (`UtilsTest.testMurmur2`) […]; verifica los vectores en la fuente, no los escribas de memoria. 2. Autocreación en el broker: usa un cliente que sí pida autocreación (`allowAutoTopicCreation: true`); debe fallar y el tópico no debe aparecer. 3. Renombra cualquier test cuyo nombre prometa más de lo que comprueba."
>
> El orquestador corrigió el ADR-001 a mano.

**Resultado** — `tests/e2e/infra-smoke.e2e.test.ts:134-146`
```ts
it("el broker no autocrea tópicos aunque el cliente lo pida (auto_create_topics_enabled desactivado)", async () => {
  const missing = `fleet.e2e.autocreate.${runId}`;
  const asking = kafka.producer({ allowAutoTopicCreation: true, retry: { retries: 1, initialRetryTime: 100 } });
  await asking.connect();
  try {
    await expect(asking.send({ topic: missing, messages: [{ key: "veh-e2e", value: "{}" }] })).rejects.toThrow();
  } finally {
    await asking.disconnect();
  }
  expect(await kafkaAdmin.listTopics()).not.toContain(missing);
});
```

**Prevención:**
- `packages/platform/src/kafka/producer.int.test.ts:80`: partición asignada por el broker contra los vectores murmur2 de Kafka.
- Smoke e2e anterior: se comprobó que es sensible activando la autocreación en el Redpanda local. El test falló, y después se restauró la configuración.

**Estándar aplicado:** regla 6 de CLAUDE.md (key = `vehicleId`, orden por vehículo) · regla 17 · **Commit:** `1948b41`, `66c9a03`, `3cf59fd`

### 3. Test de sesión inactiva que aceptaba su propio error de timeout
**Fecha:** 2026-10-05 · **Área:** packages/platform (migraciones) · **Severidad:** media · **Detectado por:** architect-reviewer
**Tipo de error de IA:** test que no prueba nada
**Reincidencia de:** #1 y #2. Apareció en el código que corregía esos hallazgos y se detectó en la segunda revisión.

**Contexto / prompt original**
> Orquestador a `backend-engineer`: "`lock_timeout` en la sesión de migración (`control.ts`): configurable, de 5 a 10 s por defecto, más `idle_in_transaction_session_timeout`."

**Lo que propuso la IA** — `packages/platform/src/migrations/rollback.int.test.ts:779` y `:788`. La línea 788 completa es TODO; el revisor la cita como `rejects.toThrow()` sin patrón.
```ts
if (Date.now() > deadline) throw new Error("La sesión inactiva no se cerró a tiempo"); // :779, polling del propio test
// :788: `rejects.toThrow()` sin patrón sobre `outcome`
```

**Por qué es deficiente**
Si `idle_in_transaction_session_timeout` no se aplicara, el polling agotaría los 10 s y lanzaría su propio error, que `toThrow()` acepta: el test pasaba en verde justo en el caso que debía detectar. Una regresión de esa configuración dejaría sesiones de migración inactivas reteniendo locks y frenando la ingesta, sin que ningún test fallara.

**Criterio aplicado y prompt correctivo**
> "H3: `rejects.toThrow()` sin patrón acepta el propio error de polling del test ('no se cerró a tiempo'). Exige que el rechazo sea el de Postgres cerrando la sesión inactiva, no el del timeout del test […]. Demuestra que el test falla si el timeout no está configurado."

**Resultado** — `packages/platform/src/migrations/rollback.int.test.ts:854-864`
```ts
const failure = await outcome.then(
  () => undefined,
  (error: unknown) => error,
);
expect(failure).toBeInstanceOf(Error);
const message = failure instanceof Error ? failure.message : "";
expect(message).not.toMatch(/no se cerró a tiempo/);
expect(message).toMatch(/connection error|Connection terminated/i);
const logged = lines.map((line) => JSON.parse(line) as { err?: { code?: string; message?: string } });
expect(logged.map((entry) => entry.err?.code)).toContain("25P03");
```

**Prevención:**
- El propio test: con el timeout en 60 s falla y con 300 ms pasa (comprobado por `backend-engineer`).
- Propuesta, todavía no aplicada: agregar a la checklist de `architect-reviewer` "aserciones de rechazo sin patrón (`rejects.toThrow()`) prohibidas".

**Estándar aplicado:** regla 17 de CLAUDE.md · **Commit:** `1948b41`
