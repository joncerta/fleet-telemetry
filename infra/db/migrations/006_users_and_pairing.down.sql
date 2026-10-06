-- Reversión de 006 (solo local: db:rollback rechaza cualquier otra base). Destruye los usuarios y los códigos de vinculación.
-- Orden inverso a las dependencias; los índices caen con sus tablas.
DROP TABLE device_pairing_codes;
DROP TABLE users;
