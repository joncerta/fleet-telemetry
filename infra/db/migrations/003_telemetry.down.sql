-- Reversión de 003 (solo local). Destruye toda la telemetría.
-- Se quita la política de compresión de forma explícita (su job de Timescale cae con la hypertable, pero así el down
-- documenta lo que deshace); luego DROP TABLE borra los chunks y los índices.
SELECT remove_compression_policy('telemetry', if_exists => true);
DROP TABLE telemetry;
