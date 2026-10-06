-- migrate:no-transaction
-- 009: agregado continuo `telemetry_hourly` (fase 1d): actividad por vehículo y hora, sin leer los puntos crudos.
--
-- Sin transacción: `WITH DATA` y las políticas de Timescale no caben en una (ver ADR-003, migraciones sin transacción). Por eso cada
-- sentencia es idempotente (`IF NOT EXISTS`, `if_not_exists`): si una falla, el siguiente `db:migrate` repite el archivo entero.
--
-- Numeración: no existe la 007 (estaba reservada) y NO se puede usar después: el runner rechaza una migración pendiente con
-- número menor que la última aplicada (la 008 ya lo está en las bases locales). Ver el ADR-003.
--
-- Qué guarda, por (tenant_id, vehicle_id, hora UTC): puntos, velocidad media y máxima (solo puntos con velocidad: `avg` ignora los
-- nulos) y cuántos puntos son simulados (`mocked`) o de baja precisión (`low_accuracy`). Son agregados derivados de datos
-- personales (Ley 1581): se leen siempre filtrando por tenant y nunca van a logs.
--
-- Tiempo real: `materialized_only = false`. Con el refresco `end_offset = 1 hour` la hora en curso aún no está materializada y el
-- panel la perdería; la vista suma lo materializado y lo que falta, calculado de `telemetry`.
--
-- Política de refresco, frente a la cola offline (el gateway acepta puntos de hasta 7 días de antigüedad por defecto):
--  - `start_offset = 8 days`: un punto tardío de hasta 7 días cae dentro de la ventana, con un día de margen por el reloj y por la
--    hora del bucket. Más viejo que 8 días (el gateway admite hasta 90 con INGEST_GATEWAY_MAX_AGE_MS) NO se refleja solo: hay que
--    lanzar `CALL refresh_continuous_aggregate('telemetry_hourly', <desde>, <hasta>)` a mano.
--  - `end_offset = 1 hour`: no se materializa el bucket en curso (se seguiría invalidando con cada punto); lo cubre el tiempo real.
--  - `schedule_interval = 15 minutes`: un punto tardío aparece en el agregado en ≤ 15 min. Cada corrida solo recalcula los buckets
--    invalidados de la ventana (log de invalidaciones), así que es barato aunque la ventana sea de 8 días.
--
-- Retención: igual que `telemetry` (004), 90 días. Sin ella el agregado conservaría la actividad por vehículo y hora después de que
-- la retención borrara los puntos (finalidad y necesidad, Ley 1581). Borra chunks enteros de la hypertable materializada (10 días),
-- así que un bucket vive hasta ~10 días más.
--
-- Permisos: solo lectura para `fleet_ro` y `fleet_app` (los privilegios por defecto de la 001 darían DML a `fleet_app`; se revoca).
--
-- Reversión: ver 009_telemetry_hourly.down.sql (solo en local).

CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry_hourly
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  time_bucket('1 hour', recorded_at) AS bucket,
  tenant_id,
  vehicle_id,
  count(*)                      AS points,
  avg(speed_mps)                AS avg_speed_mps,
  max(speed_mps)                AS max_speed_mps,
  sum(mocked::integer)          AS mocked_points,
  sum(low_accuracy::integer)    AS low_accuracy_points
FROM telemetry
GROUP BY time_bucket('1 hour', recorded_at), tenant_id, vehicle_id
WITH DATA;

SELECT add_continuous_aggregate_policy(
  'telemetry_hourly',
  start_offset => INTERVAL '8 days',
  end_offset => INTERVAL '1 hour',
  schedule_interval => INTERVAL '15 minutes',
  if_not_exists => TRUE
);

SELECT add_retention_policy('telemetry_hourly', INTERVAL '90 days', if_not_exists => TRUE);

REVOKE INSERT, UPDATE, DELETE ON telemetry_hourly FROM fleet_app;
GRANT SELECT ON telemetry_hourly TO fleet_ro, fleet_app;
