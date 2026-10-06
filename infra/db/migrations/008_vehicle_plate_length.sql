-- 008: tope de la placa de un vehículo (fase 1b, riesgo que dejó ADR-007).
--
-- `vehicles.plate` no tenía tope y el contrato de @fleet/contracts admite de 1 a 32 caracteres (`vehicleStateSchema.plate`). El
-- processor valida cada evento con el esquema estricto antes de publicarlo: una placa más larga lo haría fallar para siempre y
-- detendría la partición. La base ahora garantiza lo mismo que el contrato.
--
-- Si ya existiera una placa fuera del rango, la migración falla al validar la restricción: hay que corregirla a mano antes.
-- La 007 sigue reservada (continuous aggregate, paso S3).
--
-- Reversión: ver 008_vehicle_plate_length.down.sql (solo en local).

ALTER TABLE vehicles ADD CONSTRAINT vehicles_plate_length_check CHECK (char_length(plate) BETWEEN 1 AND 32);
