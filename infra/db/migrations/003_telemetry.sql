-- 003: telemetría (hypertable de TimescaleDB con geometría PostGIS).
--
-- Una fila por punto GPS aceptado. Todo es dato personal (Ley 1581): nada de esto va a logs.
--
-- Tiempo (regla 13): `recorded_at` es la hora del fix GPS del dispositivo (la dimensión de partición);
-- `received_at` es la hora del servidor (gateway), guardada aparte. Ambos en UTC (timestamptz).
--
-- Geografía: `geom` es geometry(Point, 4326) (WGS84). Se construye con ST_SetSRID(ST_MakePoint(lon, lat), 4326):
-- LONGITUD primero. Distancias en metros: castear a geography en la consulta. Filtros de cercanía con ST_DWithin.
--
-- Permisos: los privilegios por defecto de la 001 dan DML a fleet_app y SELECT a fleet_ro.
--
-- Sin claves foráneas a vehicles, devices ni tenants, a propósito: el gateway deriva tenant, dispositivo y vehículo
-- del token verificado (no del payload) y una FK por fila sería un lookup extra en la ruta caliente de inserción por
-- lotes. Contrapartida aceptada: borrar un vehículo no borra su telemetría; esa la limpiará la retención cuando se declare (ver el final de este archivo).
--
-- Reversión: ver 003_telemetry.down.sql (solo en local).

CREATE TABLE telemetry (
  -- UUID que genera el dispositivo al capturar el punto: llave de idempotencia de punta a punta (regla 5).
  event_id     uuid             NOT NULL,
  tenant_id    uuid             NOT NULL,
  vehicle_id   uuid             NOT NULL,
  device_id    uuid             NOT NULL,
  recorded_at  timestamptz      NOT NULL,
  received_at  timestamptz      NOT NULL,
  geom         geometry(Point, 4326) NOT NULL,
  -- double precision (no real, no numeric): pg lo devuelve como number sin perder los decimales que mandó el dispositivo.
  speed_mps    double precision,
  heading_deg  double precision,
  accuracy_m   double precision,
  altitude_m   double precision,
  mocked       boolean          NOT NULL,
  low_accuracy boolean          NOT NULL
);

-- Intervalo de chunk: 1 día.
--  - Volumen: la simulación de la fase 1b son 30 vehículos a ~1 punto cada 5 s (~0,5 M filas/día). Un chunk de un día
--    pesa del orden de 100 MB con sus índices, muy por debajo de la regla práctica de Timescale (chunk activo con sus
--    índices en torno al 25 % de la RAM); con 100 veces esa flota seguiría cabiendo.
--  - Granularidad operativa: la compresión (más abajo) y una futura retención actúan por chunk. Con el valor por
--    defecto de 7 días el chunk activo tardaría una semana en cerrarse y la compresión no empezaría hasta los 14.
--  - Puntos tardíos: reenviar un punto viejo toca un solo chunk de un día.
-- Sin el índice por defecto sobre recorded_at: todas las consultas filtran por tenant y vehículo, y el índice de
-- consulta de abajo las cubre; el índice extra solo encarecería cada inserción.
SELECT create_hypertable('telemetry', 'recorded_at', chunk_time_interval => INTERVAL '1 day', create_default_indexes => false);

-- Idempotencia (regla 5): el processor inserta con ON CONFLICT DO NOTHING. En una hypertable todo índice único debe
-- incluir la columna de tiempo, por eso es (event_id, recorded_at) y no solo (event_id).
--
-- Caso límite: el MISMO eventId con DISTINTO recordedAt no es un duplicado para este índice y quedan DOS filas. Solo
-- ocurre por un bug del dispositivo (el eventId se genera una vez por punto y su hora de fix no cambia). Un reenvío
-- legítimo del mismo punto trae el mismo par y es un no-op. Si algún día hay que tolerar el bug, se deduplica al leer.
CREATE UNIQUE INDEX telemetry_event_id_recorded_at_key ON telemetry (event_id, recorded_at);

-- Consulta principal (historial de un vehículo de un tenant, paginado por keyset sobre recorded_at).
CREATE INDEX telemetry_tenant_vehicle_recorded_at_idx ON telemetry (tenant_id, vehicle_id, recorded_at DESC);

-- Compresión. segmentby = lo que filtra cada consulta (tenant y vehículo); orderby = tiempo descendente y, al final,
-- event_id: la comprobación de unicidad del ON CONFLICT trabaja sobre las columnas del índice único, y Timescale
-- avisa si alguna no está en segmentby ni en orderby.
ALTER TABLE telemetry SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'tenant_id, vehicle_id',
  timescaledb.compress_orderby = 'recorded_at DESC, event_id'
);

-- Se comprime a los 7 días. Verificado en TimescaleDB 2.30.2: INSERT ... ON CONFLICT DO NOTHING sobre un chunk
-- COMPRIMIDO funciona (un duplicado es un no-op y un punto nuevo se inserta), así que la compresión no rompe la
-- idempotencia cuando la cola offline del móvil reenvía puntos de días atrás. Lo que cuesta es el rendimiento: el
-- chequeo descomprime los lotes afectados (~170 ms para 500 duplicados en un chunk de 340 000 filas, frente a ~2 ms sin
-- comprimir). Por eso el umbral es de una semana, para que los reenvíos habituales caigan en chunks sin comprimir. El caso
-- comprimido lo comprueban dos tests de integración: schema-rules.int.test.ts (packages/platform, el SQL a mano) y
-- pg-telemetry-repository.int.test.ts (services/processor, por insertBatch).
SELECT add_compression_policy('telemetry', INTERVAL '7 days');

-- Retención: NO se declara en esta migración. Cuánto tiempo se conserva la posición de un conductor es una decisión de
-- negocio y de la Ley 1581 (finalidad y necesidad); la agrega la migración 004 (add_retention_policy a 90 días). El topic
-- telemetry.raw retiene 3 días y telemetry.dlq 14.
