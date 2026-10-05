-- 001 (down): revierte 001_extensions_and_roles.sql en orden inverso. Tras este down, el up puede correr de nuevo.
--
-- Los roles fleet_app y fleet_ro son del CLUSTER, no de la base: este down solo puede quitar lo de la base actual
-- y no debe romper a otras bases que los usan. Por eso los DROP ROLE son condicionales (ver 4 y 5).

-- 1) Privilegios por defecto (sin FOR ROLE: los del rol que ejecuta, el mismo que los creó en el up).
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM fleet_app, fleet_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM fleet_app;

-- 2) Privilegios del esquema y de la base. No se devuelve CREATE a PUBLIC en `public`: el up solo lo hacía
--    explícito, y desde PG 15 PUBLIC ya no lo tiene.
REVOKE USAGE ON SCHEMA public FROM fleet_app, fleet_ro;

DO $$
BEGIN
  EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM fleet_app, fleet_ro', current_database());
END
$$;

-- 3) Extensiones. Sin CASCADE: si otra migración dejó objetos que dependen de ellas, su down debió quitarlos antes,
--    y es mejor fallar que borrar datos en silencio.
DROP EXTENSION IF EXISTS postgis;
DROP EXTENSION IF EXISTS timescaledb;

-- 4) Guarda de roles. Si en ESTA base queda algo que depende de fleet_app o fleet_ro (un grant olvidado, un
--    privilegio por defecto de otro rol, un objeto suyo), el down falla: no se oculta bajo la tolerancia de 5.
--    pg_shdepend registra, con el `dbid` de la base donde vive la dependencia, qué objetos usan cada rol.
DO $$
DECLARE
  remaining bigint;
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['fleet_app', 'fleet_ro'] LOOP
    SELECT count(*) INTO remaining
    FROM pg_shdepend d
    JOIN pg_roles r ON r.oid = d.refobjid
    WHERE d.refclassid = 'pg_authid'::regclass
      AND r.rolname = role_name
      AND d.dbid = (SELECT oid FROM pg_database WHERE datname = current_database());
    IF remaining > 0 THEN
      RAISE EXCEPTION 'El rol % todavía tiene % dependencia(s) en la base %: revoca esos grants antes de revertir.',
        role_name, remaining, current_database();
    END IF;
  END LOOP;
END
$$;

-- 5) Roles del cluster. Se intenta borrarlos; con la guarda de 4 ya no quedan dependencias en esta base, así que
--    dependent_objects_still_exist (2BP01) solo puede venir de OTRAS bases (o de sus grants de CONNECT), y entonces
--    el rol se conserva con un NOTICE.
DO $$
BEGIN
  DROP ROLE fleet_app;
EXCEPTION
  WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'El rol fleet_app se conserva: otras bases todavía dependen de él.';
  WHEN undefined_object THEN
    NULL;
END
$$;

DO $$
BEGIN
  DROP ROLE fleet_ro;
EXCEPTION
  WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'El rol fleet_ro se conserva: otras bases todavía dependen de él.';
  WHEN undefined_object THEN
    NULL;
END
$$;
