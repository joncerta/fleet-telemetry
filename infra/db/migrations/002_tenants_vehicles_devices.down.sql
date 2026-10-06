-- Reversión de 002 (solo local: db:rollback rechaza cualquier otra base). Destruye los tenants, vehículos y dispositivos.
-- Orden inverso a las dependencias; los índices caen con sus tablas.
DROP TABLE devices;
DROP TABLE vehicles;
DROP TABLE tenants;
