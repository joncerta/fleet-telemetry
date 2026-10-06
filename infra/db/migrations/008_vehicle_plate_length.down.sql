-- Reversión de 008 (solo local: db:rollback rechaza cualquier otra base). Quita el tope de la placa.
ALTER TABLE vehicles DROP CONSTRAINT vehicles_plate_length_check;
