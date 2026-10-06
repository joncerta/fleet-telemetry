# k6: carga y caos de la ingesta

Demuestra con números que la ingesta **no pierde ni duplica datos**: cientos de vehículos envían a ritmo fijo (modelo abierto), con duplicados reales e inválidos de las tres clases de la regla 7, y al final se comparan los conteos de punta a punta. **Solo local**: el script aborta si el objetivo no es `localhost`, y los scripts de apoyo exigen una base local (host permitido y `fleet.environment = 'local'`).

## Cómo correrlo

```bash
pnpm install && pnpm build                              # los scripts usan @fleet/platform y @fleet/contracts compilados
docker compose --profile app up -d --wait               # infraestructura + migrate + ingest-gateway + processor
node --env-file-if-exists=.env infra/k6/scripts/anchor-group.mjs      # solo la primera vez, ver más abajo
node --env-file-if-exists=.env infra/k6/scripts/setup.mjs             # tenant de carga, 300 vehículos y tokens (una vez)
node --env-file-if-exists=.env infra/k6/scripts/run.mjs               # humo de 30 s + verificación de conteos
node --env-file-if-exists=.env infra/k6/scripts/run.mjs --chaos processor-restart     # el mismo humo, con caos
```

`run.mjs` acepta `--profile smoke|load`, `--chaos processor-restart|processor-outage`, `--chaos-after <s>`, `--vehicles N`, `--seed N` y `--run-id`. Sale con código distinto de cero si falla un threshold o una comprobación de conteos. Las variables `RATE`, `DURATION` y `BURST_RATE` ajustan la carga.

- **`anchor-group.mjs`**: el processor se suscribe con `fromBeginning: true`. En un Redpanda compartido, un grupo nuevo reprocesaría todo el backlog de otras pruebas (telemetría de tenants ya borrados y rechazos repetidos en la DLQ). El script fija el grupo al final del tópico si todavía no tiene offsets; si los tiene, no hace nada.
- **`setup.mjs`**: crea (por SQL parametrizado, como `fleet_app`) el tenant de carga `f1ee7000-0000-4000-8000-0000000000f0`, sus vehículos y un dispositivo por vehículo. Revoca los dispositivos activos del tenant y emite tokens nuevos cada vez (un solo dispositivo activo por vehículo). En la base solo queda el sha256 de cada token (mismo formato `fdt_` de `@fleet/contracts`); los tokens en claro van solo a `infra/k6/.run/tokens.json`, **ignorado por git** y con permisos 0600.
- **Resultados de cada corrida**: `infra/k6/.run/<runId>.{run,k6,chaos,verify}.json` (ignorados por git).

## Qué se envía

Todo sale de funciones puras de la semilla (`SEED`, 42 por defecto), el espacio, el vehículo, el lote y el punto (`lib/model.js`): el mismo evento se regenera idéntico, y un duplicado es exactamente el mismo `eventId` y el mismo payload. El prefijo de los 8 primeros caracteres de cada `eventId` identifica la corrida (se deriva del `RUN_ID`), así la verificación cuenta por corrida sin depender de relojes.

| Categoría | Proporción | Qué se espera |
|---|---|---|
| Válidos únicos | el resto | persistidos una sola vez |
| Duplicados reales | 10% de los puntos (25% en el mismo lote, el resto en uno anterior del mismo vehículo) | `accepted` en el ACK y no-op en la base (`ON CONFLICT`) |
| Fuera de esquema (borde) | 3% | `rejected` (`invalid_schema`) en el ACK y mensaje en `telemetry.dlq` |
| Fuera de Colombia (procesamiento) | 2% | el gateway los acepta; el processor los manda a `telemetry.dlq` como `outside_operating_area`, sin reintentos |
| Envelope roto | 2% de los **lotes** | `400`, sin llegar a la DLQ |

- **Modelo abierto**: `constant-arrival-rate` (humo: 20 lotes por segundo durante 30 s, más una ráfaga offline de lotes de 200 a 500 puntos, 2 por segundo durante 8 s, que simula muchos vehículos recuperando señal a la vez). El perfil `load` usa `ramping-arrival-rate`.
- Un token autentica a **un** vehículo, así que cada lote lleva puntos de un solo vehículo (300 vehículos fijos). Los timestamps crecen por vehículo y el 15% de los lotes llega desordenado. Las coordenadas están en orden longitud, latitud y dentro del área de operación.
- Cada ACK se valida punto por punto: `accepted` debe ser exactamente el conjunto esperado y `rejected` exactamente los inválidos de borde, con motivo `invalid_schema`.

## Qué se verifica (`scripts/verify.mjs`)

Tras esperar **lag cero estable** del grupo `processor` sobre `telemetry.raw` (3 lecturas seguidas), con SQL de solo lectura (`fleet_ro`, tenant de carga y rango de tiempo) y leyendo `telemetry.dlq` desde el inicio de la corrida:

1. persistidos = válidos únicos enviados, y filas = `eventId` distintos (cero pérdidas, cero duplicados);
2. `rejected` de los ACK = puntos fuera de esquema enviados;
3. mensajes de la DLQ de la corrida, por `eventId` distinto = fuera de esquema (`invalid_schema`) + fuera de Colombia (`outside_operating_area`), sin otros códigos;
4. respuestas 400 = lotes con envelope roto, y ningún mensaje del tenant en la DLQ sin atribuir a la corrida (los envelopes rotos no llegan a la DLQ);
5. cero errores inesperados y todos los thresholds de k6.

Sin interrupciones se exige además que la DLQ no tenga mensajes repetidos. Con caos se admite y se informa: la DLQ es at-least-once y no se deduplica (ADR-005.3).

**Thresholds** (rompen la corrida): `unexpected_errors == 0`, `dropped_iterations == 0`, `checks` de cada categoría al 100% (`ack`, `accepted`, `rejected`, `broken_envelope`), y latencia del ingest de tráfico normal p95 < 400 ms y p99 < 1000 ms (ráfaga: p95 < 2 s y p99 < 4 s, lotes hasta 25 veces mayores).

## Caos

Se ejecuta con `docker compose` desde `scripts/chaos.mjs`, **junto a** k6 y nunca dentro de él. Nunca usa `down`: el stack de infraestructura es compartido.

| Escenario | Acción | Momento | Criterio de éxito |
|---|---|---|---|
| `processor-restart` (documentado) | `docker compose --profile app restart processor` | a los 12 s de la corrida (a mitad de la carga estable) | la verificación de conteos se cumple igual; el lag vuelve a cero en 90 s o menos tras terminar la carga y la acción |
| `processor-outage` (variante dura) | `stop`, 10 s de espera y `start` del processor | `--chaos-after` (a los 22 s deja lag acumulado al terminar la carga) | igual |

Como el gateway no se toca, la latencia del ingest debe mantenerse dentro de sus thresholds durante todo el caos. Los otros escenarios de la guía (Redpanda, base de datos) quedan fuera del alcance acordado: un solo escenario de caos.

## Resultados (corridas locales del 2026-10-06)

Entorno: Docker Desktop (Redpanda, TimescaleDB, gateway y processor de una réplica cada uno), k6 v2.3.0, semilla 42, 300 vehículos.

| Corrida | Lotes / puntos | Válidos únicos | Duplicados | Fuera de esquema | Fuera de Colombia | Envelopes rotos | Persistidos | DLQ (eventId distintos) | Latencia (steady) | Resultado |
|---|---|---|---|---|---|---|---|---|---|---|
| Humo (`rmuw7yvo5`) | 610 / 13 719 | 11 702 | 1 379 (10,1%) | 384 | 254 | 8 (400 = 8) | **11 702** | **638** (= 384 + 254) | p95 23 ms, p99 32 ms | OK |
| Caos `processor-restart` (`rmuw814p7`) | 609 / 13 497 | 11 519 | 1 354 (10,0%) | 377 | 247 | 8 (400 = 8) | **11 519** | **624** (= 377 + 247) | p95 28 ms, p99 45 ms | OK |
| Caos `processor-outage` (`rmuw83u4u`, parada a los 12 s) | 608 / 13 485 | 11 508 | 1 353 (10,0%) | 377 | 247 | 8 (400 = 8) | **11 508** | **624** | p95 26 ms, p99 48 ms | OK |
| Caos `processor-outage` (`rmuw86836`, parada a los 22 s, 12 s de duración) | 610 / 13 719 | 11 702 | 1 379 (10,1%) | 384 | 254 | 8 (400 = 8) | **11 702** | **638** (= 384 + 254) | p95 23 ms, p99 30 ms | OK |

| Caos `processor-restart` (`rmuw9505v`, tras reconstruir las imágenes finales) | 610 / 13 719 | 11 702 | 1 379 (10,1%) | 384 | 254 | 8 (400 = 8) | **11 702** | **638** distintos (656 mensajes: **18 repetidos**) | p95 20 ms, p99 30 ms | OK |

En las cinco corridas: `rejected` en los ACK = fuera de esquema enviados, respuestas 400 = envelopes rotos, errores inesperados 0, `dropped_iterations` 0, y el lag del consumer volvió a cero en 2 a 3 s tras terminar la carga y la acción de caos (el mínimo medible es ~2 s por las tres lecturas estables). La mezcla observada de inválidos de punto es 4,6% (2,8% fuera de esquema y 1,9% fuera de Colombia), más 1,3% de lotes con envelope roto.

Reproducibilidad: el humo (`rmuw7yvo5`) y el caos `rmuw86836` lanzaron el mismo número de lotes (610) con la misma semilla y obtuvieron exactamente los mismos conteos por categoría; solo cambian los `eventId` (el prefijo depende de la corrida). Con otro número de lotes por la temporización de k6, los conteos varían.

Historial honesto: la primera corrida de humo **falló** el threshold `dropped_iterations` (13 llegadas no lanzadas, y un p95 de 337 ms por el arranque en frío: conexiones y caché de tokens vacía). La causa era que k6 pre-asignaba solo 20 VUs; se subió la pre-asignación (60 para tráfico normal y 40 para la ráfaga) sin tocar ningún threshold, y los conteos de esa corrida ya coincidían (11 590 persistidos = 11 590 válidos únicos).

Límites de lo que demuestra: un solo processor (un rebalanceo entre réplicas no se probó); una caída de Redpanda o de la base tampoco (fuera de alcance). La parada de 10 s del processor acumula poco lag con esta carga, así que el drenaje es rápido, y solo en una de las cuatro corridas con caos (la última) el reinicio dejó mensajes repetidos en la DLQ (18 de 656): es el at-least-once documentado en ADR-005.3 (la DLQ de un tramo se publicó y el offset no alcanzó a confirmarse antes del reinicio). Por eso la comparación de la DLQ es por `eventId` distinto, y la tabla de la base no se ve afectada (`ON CONFLICT`).

## Pruebas del generador

```bash
node --test infra/k6/lib/model.test.mjs
```

Comprueba el determinismo, la mezcla observada (10% / 3% / 2% / 2%), que un duplicado repite `eventId` y payload de un punto válido enviado antes (nunca de un lote roto), el formato UUID v4 con prefijo de corrida y que nada queda en el futuro.

## Pendiente para backend-engineer

- Un endpoint de conteo **no** es necesario (decisión aprobada 6), pero ayudaría una señal de salud del processor (hoy no expone HTTP) para el `healthcheck` de compose y de ECS.
- Un modo "desde el final" del consumer (por ejemplo `PROCESSOR_FROM_BEGINNING=false`) evitaría `anchor-group.mjs`.
- Sin forma de generar inválidos de procesamiento por reintentos agotados (fallo transitorio de la base): el único inválido de procesamiento real hoy es el punto fuera de Colombia, que es el que se simula. No se inventó otro.
- `TimeoutNegativeWarning: -1791263029309 is a negative number` aparece en el stdout del processor al arrancar (y en los scripts que usan kafkajs): un `setTimeout` con un valor negativo enorme, probablemente una resta de fechas dentro de kafkajs con Node 24. Es inocuo (se ajusta a 1 ms) pero conviene revisarlo.
