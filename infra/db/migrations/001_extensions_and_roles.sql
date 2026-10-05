-- 001: extensiones y roles de aplicación.
--
-- Los roles son del cluster, no de la base. Aquí se crean NOLOGIN: `pnpm db:migrate` les da LOGIN y contraseña
-- después de migrar (FLEET_APP_PASSWORD y FLEET_RO_PASSWORD), para que ninguna contraseña viva en un archivo SQL.
--
--   fleet_app  DML (SELECT, INSERT, UPDATE, DELETE) y uso de secuencias. Es el rol de los servicios.
--   fleet_ro   solo SELECT. Verificación, tests de permisos y conteos de k6.
--
-- Ninguno de los dos puede crear objetos. El superusuario `fleet` solo migra.

-- 1) Extensiones. Van PRIMERO: los privilegios por defecto de más abajo solo afectan a lo que se cree después,
--    y las tablas de PostGIS (spatial_ref_sys...) no deben quedar con DML para fleet_app.
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS postgis;

-- 2) Roles, de forma idempotente y a prueba de carreras (dos bases del mismo cluster migrando a la vez):
--    en vez de "IF NOT EXISTS" + CREATE, se crea y se ignora el error de que ya existe.
DO $$
BEGIN
  CREATE ROLE fleet_app NOLOGIN;
EXCEPTION WHEN duplicate_object OR unique_violation THEN
  NULL;
END
$$;

DO $$
BEGIN
  CREATE ROLE fleet_ro NOLOGIN;
EXCEPTION WHEN duplicate_object OR unique_violation THEN
  NULL;
END
$$;

-- 3) Conexión y esquema. El nombre de la base no se escribe a mano: esta migración corre igual en `fleet` y
--    en las bases temporales de los tests.
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO fleet_app, fleet_ro', current_database());
END
$$;

GRANT USAGE ON SCHEMA public TO fleet_app, fleet_ro;

-- Nadie crea objetos en `public` por herencia de PUBLIC (ya es así desde PG 15; explícito para otras versiones).
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- 4) Tablas y secuencias futuras. ALTER DEFAULT PRIVILEGES sin FOR ROLE aplica a los objetos que cree el rol que
--    ejecuta esta migración (el superusuario `fleet`): las migraciones siguientes no necesitan GRANT propios.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO fleet_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO fleet_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO fleet_ro;

-- Reversión: ver 001_extensions_and_roles.down.sql, que se ejecuta con `pnpm db:rollback` (solo en local).
