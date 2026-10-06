# k6: carga y caos de la ingesta

Demuestra con números que la ingesta **no pierde ni duplica datos**: cientos de vehículos envían a ritmo fijo (modelo abierto), con duplicados reales e inválidos de las tres clases de la regla 7, y al final se comparan los conteos de punta a punta. **Solo local**: el script aborta si el objetivo no es `localhost`, y los scripts de apoyo exigen una base local (host permitido y `fleet.environment = 'local'`).

## Cómo correrlo

```bash
pnpm install && pnpm build                              # los scripts usan @fleet/platform y @fleet/contracts compilados
docker compose up -d --wait                             # 1. solo infraestructura (Redpanda + TimescaleDB + tópicos)
node --env-file-if-exists=.env infra/k6/scripts/anchor-group.mjs      # 2. ANTES del processor, solo la primera vez en un Redpanda compartido (ver más abajo)
docker compose --profile app up -d --wait               # 3. migrate + ingest-gateway + processor + fleet-api
node --env-file-if-exists=.env infra/k6/scripts/setup.mjs             # tenant de carga, 300 vehículos y tokens (una vez)
node --env-file-if-exists=.env infra/k6/scripts/run.mjs               # humo de 30 s + verificación de conteos
node --env-file-if-exists=.env infra/k6/scripts/run.mjs --chaos processor-kill        # el mismo humo, con un SIGKILL del processor
```

**El anclaje va antes de `--profile app`**: en cuanto el processor arranca crea su grupo (con `fromBeginning: true`) y empieza a procesar el backlog; anclar después ya no sirve. Si el grupo ya existe, el script no hace nada. Si el stack usa otro proyecto de compose (`COMPOSE_PROJECT_NAME`, `COMPOSE_FILE`), el caos lo respeta porque lanza `docker compose` con el entorno del proceso.

`run.mjs` acepta `--profile smoke|load`, `--chaos processor-restart|processor-outage|processor-kill`, `--chaos-after <s>`, `--vehicles N`, `--seed N` y `--run-id`. Sale con código distinto de cero si falla un threshold o una comprobación de conteos. Las variables `RATE`, `DURATION` y `BURST_RATE` ajustan la carga.

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

6. `accepted` de los ACK = `eventId` distintos aceptables que el generador calculó al construir cada lote.

Los contadores son **independientes**: `sent_*` se cuentan al enviar (lo que el script construyó) y `ack_accepted`, `ack_rejected` y `response_400` salen de la respuesta, antes de las comprobaciones por lote. Si uno se derivara del otro, compararlos sería una tautología. La lógica de comparación está en `lib/checks.js` (con tests en `lib/checks.test.mjs`).

Sin interrupciones, y con las interrupciones **ordenadas** (`processor-restart`, `processor-outage`: SIGTERM), se exige además `dlqRepeats === 0`: el consumer termina el tramo y confirma el offset antes de salir. Solo `processor-kill` (SIGKILL) admite repetidos, que se informan: la DLQ es at-least-once y no se deduplica (ADR-005.3).

**Thresholds** (rompen la corrida): `unexpected_errors == 0`, `dropped_iterations == 0`, `checks` de cada categoría al 100% (`ack`, `accepted`, `rejected`, `broken_envelope`), y latencia del ingest de tráfico normal p95 < 400 ms y p99 < 1000 ms (ráfaga: p95 < 2 s y p99 < 4 s, lotes hasta 25 veces mayores).

## Caos

Se ejecuta con `docker compose` desde `scripts/chaos.mjs`, **junto a** k6 y nunca dentro de él. Nunca usa `down`: el stack de infraestructura es compartido.

| Escenario | Acción | Momento | Criterio de éxito |
|---|---|---|---|
| `processor-restart` | `docker compose --profile app restart processor` (SIGTERM, apagado ordenado) | a los 12 s de la corrida (a mitad de la carga estable) | la verificación de conteos se cumple igual, **cero repetidos en la DLQ** y el lag vuelve a cero en 90 s o menos tras terminar la carga y la acción |
| `processor-outage` | `stop`, 10 s de espera y `start` del processor | `--chaos-after` (a los 22 s deja lag acumulado al terminar la carga) | igual |
| `processor-kill` | `kill -s SIGKILL processor`, 5 s de espera y `start` | a los 12 s: **dentro de la ráfaga offline** (10 a 18 s en humo; en `load` el defecto es 95 s, dentro de la suya) con lotes grandes en vuelo | cero pérdidas y cero duplicados en la base; en la DLQ, mismo conjunto de `eventId` (se admiten repetidos); lag a cero en 90 s o menos |

`processor-kill` es el que ejercita el fallo real del at-least-once: con SIGTERM el processor se apaga en orden y nunca se interrumpe entre persistir y confirmar. Como el gateway no se toca, la latencia del ingest debe mantenerse dentro de sus thresholds durante todo el caos. Los otros escenarios de la guía (Redpanda, base de datos) quedan fuera del alcance acordado.

## Resultados (corridas locales del 2026-10-06, tras la revisión del PR #8)

Entorno: Docker Desktop, proyecto de compose aislado (`ftiso`, con su propio Redpanda y su propia base, para no tocar el stack compartido), perfil `app` completo (gateway, processor y fleet-api `healthy`), k6 v2.3.0, semilla 42, 300 vehículos. Contadores ya independientes (ver "Qué se verifica"): las 15 comprobaciones de cada corrida salieron OK.

| Corrida | Lotes / puntos | Válidos únicos | Duplicados | Fuera de esquema | Fuera de Colombia | Envelopes rotos | Persistidos | DLQ (mensajes / eventId distintos / repetidos) | Latencia steady (p95 / p99) | Lag a cero |
|---|---|---|---|---|---|---|---|---|---|---|
| Humo (`smoke3`) | 617 / 13 497 | 11 519 | 1 354 (10,0%) | 377 | 247 | 8 (400 = 8) | **11 519** | 624 / 624 / **0** | 22 / 44 ms | 2,2 s |
| `processor-restart` (`restart1`) | 618 / 13 719 | 11 702 | 1 379 (10,1%) | 384 | 254 | 8 (400 = 8) | **11 702** | 638 / 638 / **0** | 27 / 52 ms | 2,1 s |
| `processor-restart` (`restart2`) | 617 / 13 497 | 11 519 | 1 354 (10,0%) | 377 | 247 | 8 (400 = 8) | **11 519** | 624 / 624 / **0** | 31 / 56 ms | 2,2 s |
| `processor-kill` (`kill1`, SIGKILL a los 12 s, 5 s abajo) | 618 / 13 719 | 11 702 | 1 379 (10,1%) | 384 | 254 | 8 (400 = 8) | **11 702** | 638 / 638 / **0** | 26 / 60 ms | 15,3 s |
| `processor-kill` (`kill2`) | 617 / 13 497 | 11 519 | 1 354 (10,0%) | 377 | 247 | 8 (400 = 8) | **11 519** | 624 / 624 / **0** | 97 / 134 ms | 15,3 s |

En todas: `rejected` en los ACK = fuera de esquema enviados, `accepted` = el conjunto esperado, respuestas 400 = envelopes rotos, errores inesperados 0, `dropped_iterations` 0 y thresholds cumplidos. La mezcla observada de inválidos de punto es 4,6% (2,8% fuera de esquema y 1,9% fuera de Colombia), más 1,3% de lotes con envelope roto.

Lo que dicen estas corridas, sin adornos:

- Con **SIGKILL** el drenaje tarda 15,3 s (frente a 2 s con SIGTERM): lo más probable (no medido) es que el consumer muerto deje de latir y el rebalanceo espere el `session.timeout` antes de reasignar las particiones. El criterio de 90 s se cumple con holgura.
- En las **dos** corridas con `kill` la base quedó exacta (cero pérdidas y cero duplicados, gracias a `ON CONFLICT`), pero **no apareció ningún repetido en la DLQ**: la ventana entre publicar la DLQ de un tramo y confirmar su offset es de milisegundos y 2 matanzas no la alcanzaron. Que la comprobación de "repetidos admitidos" nunca se ejercite en vivo es un límite de lo que se demostró; no se afirma que el at-least-once de la DLQ se haya observado con `kill`.
- Con **`restart`** (SIGTERM) la DLQ no repitió nada en las dos corridas, con la verificación ya exigiendo `dlqRepeats === 0`. En una corrida anterior a esta revisión (`rmuw9505v`) se habían visto 18 repetidos tras un `restart`; no se pudo reproducir aquí (0 en 2 de 2), y no se investigó la causa de aquella. Si reaparece, es un hallazgo para backend (apagado ordenado que no confirma el tramo de la DLQ), no un motivo para relajar la verificación.

Reproducibilidad: con la misma semilla y el mismo número de lotes (617 u 618, que depende de la temporización de k6) se obtienen exactamente los mismos conteos por categoría; solo cambian los `eventId` (el prefijo depende de la corrida).

Historial honesto: la primera corrida de humo de la fase 4a **falló** el threshold `dropped_iterations` (13 llegadas no lanzadas, y un p95 de 337 ms por el arranque en frío: conexiones y caché de tokens vacía). La causa era que k6 pre-asignaba solo 20 VUs; se subió la pre-asignación (60 para tráfico normal y 40 para la ráfaga) sin tocar ningún threshold. En esta revisión, la primera corrida con el contador `accepted` falló la comprobación nueva porque comparaba contra una suma que no cuenta duplicados repetidos del mismo origen en un lote; se corrigió usando el conjunto que calcula el generador, no relajando nada.

Límites de lo que demuestra: un solo processor (un rebalanceo entre réplicas no se probó); una caída de Redpanda o de la base tampoco (fuera de alcance); la ventana del at-least-once de la DLQ no se alcanzó en vivo.

## Pruebas del generador

```bash
node --test "infra/k6/lib/*.test.mjs"     # Node 24 trata un directorio como archivo: se pasa un glob
```

`model.test.mjs` comprueba el determinismo, la mezcla observada (10% / 3% / 2% / 2%), que un duplicado repite `eventId` y payload de un punto válido enviado antes (nunca de un lote roto), el formato UUID v4 con prefijo de corrida y que nada queda en el futuro. `checks.test.mjs` comprueba la verificación: que un rechazado de menos, un 400 de más, una pérdida o un duplicado la hacen fallar, que solo `processor-kill` admite repetidos en la DLQ y que una acción desconocida no relaja nada.

## Pendiente para backend-engineer

- Un endpoint de conteo **no** es necesario (decisión aprobada 6), pero ayudaría una señal de salud del processor (hoy no expone HTTP) para el `healthcheck` de compose y de ECS.
- Un modo "desde el final" del consumer (por ejemplo `PROCESSOR_FROM_BEGINNING=false`) evitaría `anchor-group.mjs`.
- Sin forma de generar inválidos de procesamiento por reintentos agotados (fallo transitorio de la base): el único inválido de procesamiento real hoy es el punto fuera de Colombia, que es el que se simula. No se inventó otro.
- `TimeoutNegativeWarning: -1791263029309 is a negative number` aparece en el stdout del processor al arrancar (y en los scripts que usan kafkajs): un `setTimeout` con un valor negativo enorme, probablemente una resta de fechas dentro de kafkajs con Node 24. Es inocuo (se ajusta a 1 ms) pero conviene revisarlo.
