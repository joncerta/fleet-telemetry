-- Reversión de 004 (solo local). Quita la política de retención (lo ya borrado no vuelve) y el índice que limita a un
-- dispositivo activo por vehículo.
SELECT remove_retention_policy('telemetry', if_exists => true);
DROP INDEX devices_one_active_per_vehicle_key;
