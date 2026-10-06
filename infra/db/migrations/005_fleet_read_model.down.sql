-- Reversión de 005 (solo local: db:rollback rechaza cualquier otra base). Destruye zonas, estados y alertas.
-- Orden inverso a las dependencias; los índices caen con sus tablas. La secuencia se borra al final: los DEFAULT de las
-- tablas dependen de ella, y ya no existen.
DROP TABLE alerts;
DROP TABLE vehicle_state;
DROP TABLE zones;
DROP SEQUENCE fleet_event_seq;
