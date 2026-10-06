-- migrate:no-transaction
-- Revierte la 009: quita las políticas y el agregado continuo (con su hypertable materializada). Idempotente sentencia por sentencia:
-- `if_exists` solo cubre una política ausente, no una vista ausente, así que las políticas se quitan solo si la vista existe.
-- Solo en local. Lo materializado se pierde; se recalcula desde `telemetry` al volver a aplicar la 009.

DO $$
BEGIN
  IF to_regclass('public.telemetry_hourly') IS NOT NULL THEN
    PERFORM remove_retention_policy('telemetry_hourly', if_exists => TRUE);
    PERFORM remove_continuous_aggregate_policy('telemetry_hourly', if_exists => TRUE);
  END IF;
END
$$;

DROP MATERIALIZED VIEW IF EXISTS telemetry_hourly;
