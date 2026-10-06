# Evidencia de persistencia (requisito A2, ADR-002)

Generado por `pnpm db:evidence` el 2026-10-06T18:19:24.752Z. Datos sintéticos con semilla 20261006, en una base temporal con las migraciones reales (se borra al terminar). No edites este archivo a mano: se regenera.

## Entorno y dataset

| | |
|---|---|
| PostgreSQL | PostgreSQL 17.11 (Ubuntu 17.11-1.pgdg22.04+2) on x86_64-pc-linux-gnu, compiled by gcc (Ubuntu 11.4.0-1ubuntu1~22.04.3) 11.4.0, 64-bit |
| TimescaleDB | 2.30.2 |
| PostGIS | 3.6.4 |
| CPU | 13th Gen Intel(R) Core(TM) i7-13700HX (24 CPU visibles) |
| Memoria | 7.6 GiB visibles para el servidor |
| shared_buffers / work_mem | desconocido / desconocido |
| Filas de telemetría | 12,096,000 (300 vehículos x 14 días x 1 punto cada 30 s, 2 tenants, Colombia) |
| Chunks | 15 (intervalo de 1 día) |
| Zonas | 4000 |
| Carga | 301120 ms (INSERT por lotes con unnest, con los índices de la migración 003) |

## 1. Exclusión de chunks

Historial de un vehículo en un rango de 2 horas (`tenant_id`, `vehicle_id` y `recorded_at` con rango, `ORDER BY recorded_at DESC LIMIT 500`).

| Caso | Chunks escaneados | Chunks totales | Primera | Mediana de 5 |
|---|---|---|---|---|
| historial de un vehículo, 2 h recientes (chunk sin comprimir) | 1 | 15 | 0.12 ms | 0.08 ms |
| historial de un vehículo, 2 h en un chunk comprimido | 1 | 15 | 0.17 ms | 0.13 ms |

EXPLAIN (ANALYZE, BUFFERS), historial de un vehículo, 2 h recientes (chunk sin comprimir):

```text
Limit  (cost=0.42..120.50 rows=120 width=64) (actual time=0.008..0.057 rows=240 loops=1)
  Buffers: shared hit=12
  ->  Index Scan using _hyper_1_15_chunk_telemetry_tenant_vehicle_recorded_at_idx on _hyper_1_15_chunk  (cost=0.42..120.50 rows=120 width=64) (actual time=0.008..0.042 rows=240 loops=1)
        Index Cond: ((tenant_id = 'f4db95ff-ad37-4e5e-ba0b-4c3595287daa'::uuid) AND (vehicle_id = '37dfd315-fef9-4411-9e42-1c0d02d7cdfc'::uuid) AND (recorded_at >= '2026-10-06 15:00:00+00'::timestamp with time zone) AND (recorded_at < '2026-10-06 17:00:00+00'::timestamp with time zone))
        Buffers: shared hit=12
Planning:
  Buffers: shared hit=10
Planning Time: 0.176 ms
Execution Time: 0.072 ms
```

EXPLAIN (ANALYZE, BUFFERS), historial de un vehículo, 2 h en un chunk comprimido:

```text
Limit  (cost=12.10..12.10 rows=500 width=64) (actual time=0.068..0.101 rows=240 loops=1)
  Buffers: shared hit=19
  ->  Custom Scan (ColumnarScan) on _hyper_1_4_chunk  (cost=12.10..12.10 rows=960 width=64) (actual time=0.067..0.085 rows=240 loops=1)
        Vectorized Filter: ((recorded_at >= '2026-09-25 12:00:00+00'::timestamp with time zone) AND (recorded_at < '2026-09-25 14:00:00+00'::timestamp with time zone))
        Rows Removed by Filter: 760
        Buffers: shared hit=19
        ->  Index Scan using _hyper_1_4_chunk_compressed_tenant_id_vehicle_id__ts_meta_v_idx on _hyper_1_4_chunk_compressed  (cost=0.28..2.50 rows=1 width=212) (actual time=0.009..0.009 rows=1 loops=1)
              Index Cond: ((tenant_id = 'f4db95ff-ad37-4e5e-ba0b-4c3595287daa'::uuid) AND (vehicle_id = '37dfd315-fef9-4411-9e42-1c0d02d7cdfc'::uuid) AND (_ts_meta_v2_first_recorded_at >= '2026-09-25 12:00:00+00'::timestamp with time zone) AND (_ts_meta_v2_last_recorded_at < '2026-09-25 14:00:00+00'::timestamp with time zone))
              Buffers: shared hit=3
Planning:
  Buffers: shared hit=14
Planning Time: 0.289 ms
Execution Time: 0.125 ms
```

## 2. Compresión

Se comprimieron 7 chunks de más de 7 días (lo que haría la política) en 10163 ms. `segmentby = tenant_id, vehicle_id`, `orderby = recorded_at DESC, event_id`.

| Medida | Antes | Después | Razón |
|---|---|---|---|
| `hypertable_detailed_size`, total | 3.8 GiB | 2.4 GiB | 1.6x |
| tabla | 2.1 GiB | 1.1 GiB | 1.8x |
| índices | 1.8 GiB | 996.7 MiB | 1.8x |
| toast | 128.0 KiB | 335.3 MiB | 0.0x |
| `chunk_compression_stats`, solo chunks comprimidos | 1.7 GiB | 345.6 MiB | 5.0x |

## 3. Continuous aggregate frente a la consulta cruda

"Puntos por vehículo y hora del último día" de un tenant. Refresco completo inicial de `telemetry_hourly`: 10228 ms. Puntos de la ventana: 432000 (directo) y 432000 (suma del agregado): coinciden.

| Consulta | Filas | Primera | Mediana de 5 | Chunks escaneados |
|---|---|---|---|---|
| telemetry_hourly (último día) | 3600 | 1.95 ms | 1.93 ms | 1 |
| agregación directa sobre telemetry (último día) | 3600 | 120 ms | 119 ms | 2 |

Aceleración (mediana): 62.1x.

EXPLAIN del agregado:

```text
Append  (cost=0.29..391.10 rows=3601 width=32) (actual time=0.019..1.598 rows=3600 loops=1)
  Buffers: shared hit=466
  ->  Subquery Scan on "*SELECT* 1"  (cost=0.29..373.07 rows=3600 width=32) (actual time=0.018..1.374 rows=3600 loops=1)
        Buffers: shared hit=466
        ->  Result  (cost=0.29..337.07 rows=3600 width=80) (actual time=0.018..1.076 rows=3600 loops=1)
              Buffers: shared hit=466
              ->  Index Scan using _hyper_2_16_chunk__materialized_hypertable_2_bucket_idx on _hyper_2_16_chunk  (cost=0.29..301.07 rows=3600 width=32) (actual time=0.017..0.777 rows=3600 loops=1)
                    Index Cond: ((bucket < '2026-10-06 18:00:00+00'::timestamp with time zone) AND (bucket >= '2026-10-05 18:00:00+00'::timestamp with time zone) AND (bucket < '2026-10-06 18:00:00+00'::timestamp with time zone))
                    Filter: (tenant_id = 'f4db95ff-ad37-4e5e-ba0b-4c3595287daa'::uuid)
                    Rows Removed by Filter: 3600
                    Buffers: shared hit=466
  ->  Subquery Scan on "*SELECT* 2"  (cost=0.00..0.02 rows=1 width=32) (actual time=0.001..0.001 rows=0 loops=1)
        ->  HashAggregate  (cost=0.00..0.01 rows=1 width=80) (actual time=0.001..0.001 rows=0 loops=1)
              Group Key: time_bucket('01:00:00'::interval, recorded_at), vehicle_id
              Batches: 1  Memory Usage: 24kB
              ->  Result  (cost=0.00..0.00 rows=0 width=40) (actual time=0.000..0.000 rows=0 loops=1)
                    One-Time Filter: false
Planning:
  Buffers: shared hit=17
Planning Time: 0.288 ms
Execution Time: 1.742 ms
```

EXPLAIN de la consulta cruda:

```text
Finalize HashAggregate  (cost=56068.04..62201.12 rows=350187 width=32) (actual time=115.419..115.887 rows=3600 loops=1)
  Group Key: telemetry.vehicle_id, (time_bucket('01:00:00'::interval, telemetry.recorded_at))
  Planned Partitions: 16  Batches: 1  Memory Usage: 1169kB
  Buffers: shared hit=9591
  ->  Append  (cost=17097.30..50605.17 rows=128420 width=32) (actual time=35.358..114.740 rows=3600 loops=1)
        Buffers: shared hit=9591
        ->  Partial HashAggregate  (cost=17097.30..19159.00 rows=63674 width=32) (actual time=35.358..35.575 rows=900 loops=1)
              Group Key: _hyper_1_14_chunk.vehicle_id, time_bucket('01:00:00'::interval, _hyper_1_14_chunk.recorded_at)
              Batches: 1  Memory Usage: 1681kB
              Buffers: shared hit=5473
              ->  Index Only Scan using _hyper_1_14_chunk_telemetry_tenant_vehicle_recorded_at_idx on _hyper_1_14_chunk  (cost=0.42..12734.59 rows=108013 width=24) (actual time=0.017..23.471 rows=108000 loops=1)
                    Index Cond: ((tenant_id = 'f4db95ff-ad37-4e5e-ba0b-4c3595287daa'::uuid) AND (recorded_at >= '2026-10-05 18:00:00+00'::timestamp with time zone) AND (recorded_at < '2026-10-06 18:00:00+00'::timestamp with time zone))
                    Heap Fetches: 0
                    Buffers: shared hit=5473
        ->  Partial HashAggregate  (cost=26141.43..30804.07 rows=64746 width=32) (actual time=78.445..78.935 rows=2700 loops=1)
              Group Key: _hyper_1_15_chunk.vehicle_id, time_bucket('01:00:00'::interval, _hyper_1_15_chunk.recorded_at)
              Batches: 1  Memory Usage: 1809kB
              Buffers: shared hit=4118
              ->  Index Only Scan using _hyper_1_15_chunk_telemetry_tenant_vehicle_recorded_at_idx on _hyper_1_15_chunk  (cost=0.42..12860.35 rows=328816 width=24) (actual time=0.015..42.569 rows=324000 loops=1)
                    Index Cond: ((tenant_id = 'f4db95ff-ad37-4e5e-ba0b-4c3595287daa'::uuid) AND (recorded_at >= '2026-10-05 18:00:00+00'::timestamp with time zone) AND (recorded_at < '2026-10-06 18:00:00+00'::timestamp with time zone))
                    Heap Fetches: 0
                    Buffers: shared hit=4118
Planning:
  Buffers: shared hit=16
Planning Time: 0.320 ms
Execution Time: 116.327 ms
```

## 4. Idempotencia sobre un chunk comprimido

`INSERT ... ON CONFLICT (event_id, recorded_at) DO NOTHING` (el SQL del processor) de 500 duplicados consecutivos de un vehículo; las 7 repeticiones son no-op (se verifica que no inserte ninguna fila).

| Chunk | Filas del chunk | Primera | Mediana de 7 |
|---|---|---|---|
| comprimido | 864000 | 96.3 ms | 75.2 ms |
| sin comprimir | 864000 | 14.7 ms | 7.07 ms |

Comprimido frente a sin comprimir: 11x más lento. Medición previa (ADR-004.3, 340 000 filas por chunk): ~170 ms comprimido frente a ~2 ms sin comprimir (~85x). Aquí los chunks tienen 864000 filas.

## 5. Consulta espacial

Vehículos detenidos dentro de una zona crítica (`ST_Covers` contra `zones.geom`, índice GIST `zones_geom_idx`). Un tenant: 44 vehículos detenidos, 436 zonas críticas; devuelve 45 filas. primera 1.74 ms, mediana de 5: 0.73 ms (planificación 0.65 ms); chunks escaneados: 0.

Plan natural (usa `zones_geom_idx`):

```text
Limit  (cost=0.15..566.52 rows=70 width=32) (actual time=0.032..0.710 rows=45 loops=1)
  Buffers: shared hit=148
  ->  Nested Loop  (cost=0.15..566.52 rows=70 width=32) (actual time=0.032..0.706 rows=45 loops=1)
        Buffers: shared hit=148
        ->  Seq Scan on vehicle_state vs  (cost=0.00..11.50 rows=39 width=64) (actual time=0.009..0.038 rows=44 loops=1)
              Filter: ((tenant_id = 'f4db95ff-ad37-4e5e-ba0b-4c3595287daa'::uuid) AND (movement = 'stopped'::text))
              Rows Removed by Filter: 256
              Buffers: shared hit=7
        ->  Index Scan using zones_geom_idx on zones z  (cost=0.15..14.22 rows=1 width=152) (actual time=0.015..0.015 rows=1 loops=44)
              Index Cond: (geom ~ vs.geom)
              Filter: ((tenant_id = 'f4db95ff-ad37-4e5e-ba0b-4c3595287daa'::uuid) AND (kind = 'critical'::text) AND st_covers(geom, vs.geom))
              Rows Removed by Filter: 0
              Buffers: shared hit=141
Planning:
  Buffers: shared hit=4
Planning Time: 0.645 ms
Execution Time: 0.726 ms
```
