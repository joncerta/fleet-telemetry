-- 004: retención de la telemetría y un solo dispositivo activo por vehículo (decisiones del humano, ADR-004).
--
-- Retención de 90 días. La posición de un conductor es un dato personal (Ley 1581): se conserva lo necesario para la
-- operación y se borra después. Timescale elimina CHUNKS enteros (de 1 día) cuando todo su rango supera los 90 días, así
-- que un punto puede sobrevivir hasta 1 día más. Es borrado irreversible: la política corre en un job de Timescale,
-- no en la ruta de inserción. Convive con la compresión de 003 (a los 7 días): cada política actúa por chunk y no se estorban.
--
-- Consecuencia para la ingesta: sin una cota de antigüedad, un punto con más de 90 días se insertaría y el job lo borraría en
-- su siguiente pasada. Por eso el gateway rechaza lo más viejo que INGEST_GATEWAY_MAX_AGE_MS (7 días por defecto, como mucho
-- 90) como stale_timestamp, y el processor rechaza como stale_timestamp lo que supera los 90 días de la retención (ADR-004.10
-- y ADR-005.9). La idempotencia sigue funcionando sobre chunks comprimidos.
--
-- Un solo dispositivo activo por vehículo. Índice único PARCIAL sobre devices(vehicle_id): los dispositivos revocados
-- no cuentan, así que rotar el token (revocar el activo y crear el nuevo, en una transacción) sigue funcionando.
-- `devices` es una tabla normal (no hypertable): el índice único no necesita la columna de tiempo.
-- Si ya existieran dos dispositivos activos del mismo vehículo, la migración falla al crear el índice: hay que revocar
-- uno a mano antes (en local, `pnpm device:token` rota y deja uno solo).
--
-- Reversión: ver 004_telemetry_retention_and_single_active_device.down.sql (solo en local).

SELECT add_retention_policy('telemetry', INTERVAL '90 days');

CREATE UNIQUE INDEX devices_one_active_per_vehicle_key ON devices (vehicle_id) WHERE revoked_at IS NULL;
