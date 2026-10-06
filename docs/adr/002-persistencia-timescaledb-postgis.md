# ADR-002 — Persistencia de telemetría: TimescaleDB + PostGIS frente a Cassandra, y por qué no Druid (fase 1d)

- **Estado:** aceptado
- **Fecha:** 2026-10-06
- **Requisito:** A2 del plan, persistencia de alta frecuencia justificada.
- **Evidencia:** [`docs/evidence/persistence.md`](../evidence/persistence.md), generada por `pnpm db:evidence` sobre una base temporal con las migraciones reales. Se regenera; no se edita a mano.
- **Relacionados:**
  - ADR-001: stack.
  - ADR-003: migraciones; la `007` no existe y el aggregate es la `009`.
  - ADR-004.3: la hypertable, la compresión y la retención.
  - ADR-005: el sink idempotente del processor.
  - ADR-007: el estado y las alertas.
  - ADR-010: TimescaleDB en EC2.

## Contexto

Qué tiene que resolver la persistencia:

1. **Escritura continua de alta frecuencia.** Un punto GPS por vehículo cada pocos segundos, con picos cuando la cola offline de los móviles se vacía al recuperar la señal.
2. **Idempotencia de punta a punta (regla 5).** Un reenvío del móvil o una reentrega de Kafka nunca duplica una fila. La deduplicación vive en la base, no en memoria.
3. **Estado por vehículo y alertas**, con transacciones. Es el read model de fleet-api.
4. **Consultas geoespaciales.** Por ejemplo, "detenidos dentro de una zona crítica", con polígonos arbitrarios por tenant.
5. **Consultas acotadas** por tenant, vehículo y rango de tiempo, para el dashboard y para las herramientas tipadas del agente (regla 10, sin text-to-SQL).
6. **Agregados por hora** para reportes, sin recorrer los puntos crudos.
7. **Retención de 90 días**, decisión del humano por la Ley 1581: la posición de un conductor no se conserva indefinidamente.

Carga de referencia: el humo de k6 persistió 11 519 puntos válidos únicos en 30 s, unos 380 puntos/s, con un p99 del ingest de 32 ms (README §5). Una flota de 500 vehículos con un punto cada 5 s son 100 puntos/s.

## Decisión

**TimescaleDB 2.30 + PostGIS 3.6 sobre PostgreSQL 17**, una sola base para la telemetría y el read model.

1. **Hypertable `telemetry` con chunks de 1 día** (ADR-004.3).
   - Índice único `(event_id, recorded_at)`: en una hypertable, el índice único tiene que incluir la columna de tiempo.
   - El processor inserta con `INSERT … ON CONFLICT (event_id, recorded_at) DO NOTHING` y confirma el offset después de persistir. La entrega es at-least-once, pero el sink idempotente hace que el efecto sea de una sola vez.
2. **Compresión a los 7 días**, con `segmentby = tenant_id, vehicle_id` y `orderby = recorded_at DESC, event_id`.
3. **Retención de 90 días** sobre `telemetry`.
4. **Continuous aggregate `telemetry_hourly`** (migración 009).
   - Guarda puntos, velocidad media y máxima, y puntos simulados o de baja precisión, por tenant, vehículo y hora.
   - Agregación en tiempo real: `materialized_only = false`.
   - Refresco: ventana de 8 días, sin la hora en curso, cada 15 min.
   - Retención de 90 días, igual que los puntos crudos: no tendría sentido conservar la actividad por hora de un vehículo después de borrar sus puntos.
   - Solo lectura para `fleet_app` y `fleet_ro`.
5. **PostGIS para zonas y posiciones.** Columnas `geometry(Point, 4326)` y `geometry(Polygon, 4326)`, construidas con `ST_SetSRID(ST_MakePoint(lon, lat), 4326)` (longitud primero), e índice GIST `zones_geom_idx`. La consulta de "detenidos en zona crítica" usa `ST_Covers`.

## Evidencia

Medido con 12 096 000 filas (300 vehículos, 14 días, un punto cada 30 s, 2 tenants, 15 chunks) en un portátil con i7-13700HX y 7,6 GiB para Docker. Son datos sintéticos, así que lo que importa son las proporciones, no los milisegundos exactos. El detalle y los `EXPLAIN (ANALYZE, BUFFERS)` están en la evidencia.

| Qué | Resultado | Por qué importa |
|---|---|---|
| Exclusión de chunks: historial de 2 h de un vehículo | Se escanea **1 de 15 chunks**. Mediana de 0,08 ms sin comprimir y 0,13 ms comprimido (index scan sobre los metadatos del segmento) | Las consultas acotadas de la API y del agente no dependen del tamaño del histórico |
| Compresión de los chunks de más de 7 días | **5,0x** en los chunks comprimidos (1,7 GiB → 345,6 MiB). La hypertable completa pasa de 3,8 a 2,4 GiB, con 7 de 15 chunks comprimidos | 90 días de retención caben en disco con margen. El TOAST crece porque ahí viven los datos columnares; no es una regresión |
| Continuous aggregate frente a la agregación cruda (puntos por vehículo y hora del último día de un tenant) | **1,93 ms frente a 119 ms (62x)**. Las dos cuentan los mismos 432 000 puntos | Los reportes por hora no recorren los puntos crudos, y el tiempo real cubre la hora en curso |
| Idempotencia: 500 duplicados, todos no-op | 7,07 ms en un chunk sin comprimir y 75,2 ms en uno comprimido (**11x**) | Funciona en los dos casos, pero cuesta más en los comprimidos. Por eso el gateway acepta como máximo 7 días de antigüedad por defecto, igual que el umbral de compresión |
| Consulta espacial: detenidos en zona crítica (44 vehículos, 436 zonas) | **0,73 ms**, con GIST | La regla de negocio del agente se resuelve con SQL parametrizado |
| Carga: 12,1 M filas | 301 s, **unas 40 000 filas/s con una sola conexión** (lotes con `unnest`, con los índices de la 003) | Dos órdenes de magnitud por encima de la carga de referencia, en un solo nodo |

## Alternativas descartadas

### Cassandra

Es lo natural para escritura masiva distribuida: LSM, escala lineal añadiendo nodos y sin punto único de escritura. Además sus escrituras son *upserts* por clave primaria, así que la idempotencia por `eventId` no sería un problema. Se descarta por todo lo demás:
- **No hay consultas geoespaciales.** "Detenidos dentro de un polígono" exigiría otro motor o resolverlo en la aplicación con datos copiados.
- **El modelo es por consulta.** Cada lectura necesita su propia tabla desnormalizada, así que cada herramienta nueva del agente o cada filtro del dashboard sería una tabla más y una doble escritura. No hay joins con zonas, vehículos ni usuarios.
- **No hay agregados.** Los reportes por hora necesitarían Spark, Flink o un job propio.
- **El read model es relacional y transaccional** (usuarios, dispositivos, vinculación, `vehicle_state`, alertas). Igual haría falta PostgreSQL, y quedarían dos bases que operar y mantener consistentes.
- **Costo operativo.** Un clúster mínimo de 3 nodos con RF=3, más `repair`, compactación y tombstones de la retención por TTL.

Lo que ofrece, escala horizontal de escritura, solo vale la pena muy por encima de lo que se necesita aquí: un nodo ya sostiene unas 40 000 filas/s frente a unas 380/s de carga.

### Druid (y OLAP en general)

Es excelente para agregaciones *slice-and-dice* sobre eventos inmutables con ingesta desde Kafka. No sirve como store principal:
- **No deduplica por `eventId`.** La ingesta desde Kafka es *exactly-once* respecto de los offsets, pero un reenvío del móvil es otro mensaje con otro offset. Habría que deduplicar antes de Druid, que es justo lo que la regla 5 prohíbe hacer solo en memoria.
- **No sirve para estado transaccional ni lecturas puntuales:** `vehicle_state`, vinculación, alertas que se abren y se cierran.
- **Su soporte geoespacial es limitado** frente a PostGIS: no tiene tipos geométricos ni joins indexados contra una tabla de zonas.
- **Despliegue pesado:** Coordinator, Overlord, Broker, Historical y MiddleManager, más deep storage y una base de metadatos.

La necesidad analítica real, los agregados por hora, la cubre el continuous aggregate en la misma base, con un 62x de aceleración.

### PostgreSQL sin TimescaleDB (particionado nativo)

Funcionaría, pero obliga a crear y borrar las particiones a mano o con `pg_partman`. Además no tiene compresión columnar (el 5x medido) ni continuous aggregates: cada reporte por hora sería una vista materializada que se refresca entera, o un job propio.

### InfluxDB, QuestDB y similares

Son buenos para series temporales, pero no tienen PostGIS ni un modelo relacional para el read model. Volvería a haber dos bases.

## Consecuencias

- **Una sola base primaria, que escala vertical.** El histórico se escala con compresión y retención; las lecturas, con réplicas. Si la ingesta sostenida se acercara a lo medido en un nodo, o un chunk diario superara el ~25% de la RAM, las salidas son:
  - **chunks más cortos**;
  - **réplicas de lectura** para el dashboard;
  - **particionar por tenant** en varias instancias, porque el tenant ya está en todas las claves y consultas;
  - **Timescale Cloud** con tiered storage para el histórico frío.

  El multi-nodo de Timescale está descontinuado, así que no es una opción.
- **Escribir en chunks comprimidos cuesta 11 veces más.** La cola offline reenvía normalmente en horas, con chunks sin comprimir. Por eso el límite de antigüedad del gateway (`INGEST_GATEWAY_MAX_AGE_MS`) coincide con el umbral de compresión. Subirlo hacia los 90 días es posible, pero los reenvíos muy tardíos serán más lentos.
- **Los puntos de más de 8 días de antigüedad no entran solos en `telemetry_hourly`.** Hay que lanzar `CALL refresh_continuous_aggregate(...)` a mano, como documenta la 009.
- **La retención es irreversible.** `db:rollback` quita la política, pero lo ya borrado no vuelve.
- **En AWS, TimescaleDB va autogestionado en EC2** (ADR-010), porque RDS no lo trae. La alternativa gestionada es Timescale Cloud.
- **Sin claves foráneas desde `telemetry`** (ADR-004.3). Tenant, vehículo y dispositivo salen del token verificado, y una FK por fila sería un lookup en la ruta caliente.
