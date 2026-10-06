-- 005: read model de la flota (fase 1b): zonas, estado actual de cada vehículo y alertas.
--
-- Lo escribe el processor (a partir de `telemetry.raw`) y lo lee fleet-api. La telemetría histórica sigue en `telemetry`
-- (003); aquí vive solo lo que responde "dónde está ahora" y "qué alertas hay", con una fila por vehículo o por alerta.
--
-- Multi-tenant (regla 4): toda tabla lleva `tenant_id` y las claves foráneas COMPUESTAS impiden que una fila apunte a un padre
-- de otro tenant (un vehículo, una zona o un usuario ajenos). Las consultas filtran siempre por tenant.
--
-- Orden de los eventos (regla 9 y `fleet.ts` de @fleet/contracts): `fleet_event_seq` es UNA secuencia global. Cada actualización
-- de `vehicle_state` o de `alerts` toma un valor nuevo. IMPORTANTE: el DEFAULT solo corre en un INSERT; en un
-- `ON CONFLICT DO UPDATE` (o un UPDATE) hay que escribir `seq = nextval('fleet_event_seq')` explícitamente, o la fila conservaría su
-- `seq` anterior y los clientes descartarían la actualización por vieja. bigint llega como string desde `pg`: conviértelo.
--
-- Tiempo y geografía (regla 13): timestamptz en UTC; geometrías SRID 4326 con `ST_MakePoint(lon, lat)` (longitud primero).
-- Distancias en metros: castear a geography en la consulta. Posición, placa y todo el estado de un vehículo son datos personales
-- (Ley 1581): nada de esto va a logs.
--
-- Permisos: los privilegios por defecto de la 001 dan DML a fleet_app (y USAGE, SELECT en secuencias) y SELECT a fleet_ro.
--
-- Reversión: ver 005_fleet_read_model.down.sql (solo en local).

CREATE SEQUENCE fleet_event_seq AS bigint START WITH 1 INCREMENT BY 1 NO CYCLE;

-- Zonas de interés de un tenant: polígonos (críticas, depósitos, clientes). Se editan poco y se leen mucho.
CREATE TABLE zones (
  zone_id    uuid                    PRIMARY KEY,
  tenant_id  uuid                    NOT NULL REFERENCES tenants (id),
  name       text                    NOT NULL,
  kind       text                    NOT NULL,
  geom       geometry(Polygon, 4326) NOT NULL,
  created_at timestamptz             NOT NULL DEFAULT now(),
  CONSTRAINT zones_kind_check CHECK (kind IN ('critical', 'depot', 'customer')),
  -- Un polígono inválido (auto-intersección) hace que ST_Covers y ST_Contains den resultados erróneos sin avisar.
  CONSTRAINT zones_geom_valid_check CHECK (ST_IsValid(geom)),
  CONSTRAINT zones_tenant_name_key UNIQUE (tenant_id, name),
  -- Objetivo de la FK compuesta de `alerts`: `zone_id` ya es único, pero una FK compuesta necesita un índice único exacto.
  CONSTRAINT zones_zone_tenant_key UNIQUE (zone_id, tenant_id)
);

-- Qué zonas contienen un punto: ST_Covers / ST_DWithin sobre `geom` (el processor, por cada punto). Se filtra además por tenant.
CREATE INDEX zones_geom_idx ON zones USING GIST (geom);

-- Último estado de cada vehículo: UNA fila por vehículo (PK `vehicle_id`), actualizada por el processor.
CREATE TABLE vehicle_state (
  vehicle_id    uuid                  PRIMARY KEY,
  tenant_id     uuid                  NOT NULL,
  geom          geometry(Point, 4326) NOT NULL,
  -- Hora del fix GPS del dispositivo (con ella se calcula la detención) y hora del servidor al recibirlo (base de `no_signal`).
  recorded_at   timestamptz           NOT NULL,
  received_at   timestamptz           NOT NULL,
  speed_mps     double precision,
  heading_deg   double precision,
  -- `moving` o `stopped`. `no_signal` NO se guarda: lo deriva fleet-api al leer (receivedAt con más de 5 minutos).
  movement      text                  NOT NULL,
  -- Desde cuándo está detenido, con la hora del fix GPS. Solo tiene valor mientras `movement = 'stopped'`.
  stopped_since timestamptz,
  zone_ids      uuid[]                NOT NULL DEFAULT '{}',
  mocked        boolean               NOT NULL,
  low_accuracy  boolean               NOT NULL,
  seq           bigint                NOT NULL DEFAULT nextval('fleet_event_seq'),
  updated_at    timestamptz           NOT NULL DEFAULT now(),
  CONSTRAINT vehicle_state_vehicle_tenant_fkey FOREIGN KEY (vehicle_id, tenant_id) REFERENCES vehicles (id, tenant_id),
  CONSTRAINT vehicle_state_movement_check CHECK (movement IN ('moving', 'stopped')),
  -- La misma invariante del contrato (`vehicleStateSchema`): stoppedSince es null si y solo si el vehículo se mueve.
  CONSTRAINT vehicle_state_stopped_since_check CHECK ((movement = 'stopped') = (stopped_since IS NOT NULL))
);

-- Resumen de la flota: conteos por tenant y movimiento; `received_at` en INCLUDE para derivar `noSignal` sin leer la tabla.
CREATE INDEX vehicle_state_tenant_movement_idx ON vehicle_state (tenant_id, movement) INCLUDE (received_at);

-- Vehículos detenidos más de X minutos: por tenant, los que llevan más tiempo primero (`stopped_since` ascendente). Parcial:
-- solo los detenidos.
CREATE INDEX vehicle_state_stopped_idx ON vehicle_state (tenant_id, stopped_since) WHERE movement = 'stopped';

-- Alertas de la flota. El `alert_id` es un uuid v5 DETERMINISTA (`alertIdName` y `ALERT_ID_NAMESPACE` de @fleet/contracts): reprocesar
-- el mismo mensaje produce la misma fila (idempotencia, regla 5), y la resolución actualiza esa fila. La placa y el nombre de la
-- zona no se duplican aquí: salen de `vehicles` y `zones`.
CREATE TABLE alerts (
  alert_id    uuid        PRIMARY KEY,
  tenant_id   uuid        NOT NULL,
  vehicle_id  uuid        NOT NULL,
  type        text        NOT NULL,
  zone_id     uuid,
  -- Cuándo empezó la condición (hora del fix GPS), cuándo la levantó el processor (hora del servidor) y cuándo se resolvió.
  started_at  timestamptz NOT NULL,
  raised_at   timestamptz NOT NULL,
  resolved_at timestamptz,
  seq         bigint      NOT NULL DEFAULT nextval('fleet_event_seq'),
  CONSTRAINT alerts_vehicle_tenant_fkey FOREIGN KEY (vehicle_id, tenant_id) REFERENCES vehicles (id, tenant_id),
  -- Con `zone_id` nulo (alertas sin zona, como mocked_location) la FK no se comprueba (MATCH SIMPLE); con valor, la zona debe ser
  -- del mismo tenant.
  CONSTRAINT alerts_zone_tenant_fkey FOREIGN KEY (zone_id, tenant_id) REFERENCES zones (zone_id, tenant_id),
  CONSTRAINT alerts_type_check CHECK (type IN ('critical_zone_stop', 'mocked_location'))
);

-- Alertas ACTIVAS por tenant (el resumen y el snapshot), de la más reciente a la más antigua: el orden del keyset de `GET /v1/alerts`
-- es (raised_at DESC, alert_id DESC); `alert_id` desempata.
CREATE INDEX alerts_active_idx ON alerts (tenant_id, raised_at DESC, alert_id DESC) WHERE resolved_at IS NULL;

-- Todas las alertas (`status=all`), mismo orden.
CREATE INDEX alerts_tenant_raised_idx ON alerts (tenant_id, raised_at DESC, alert_id DESC);

-- Alertas de un vehículo y comprobación de la FK compuesta al borrar o cambiar un vehículo.
CREATE INDEX alerts_vehicle_tenant_idx ON alerts (vehicle_id, tenant_id);

-- Comprobación de la FK compuesta de `alerts.zone_id` al borrar o cambiar una zona.
CREATE INDEX alerts_zone_tenant_idx ON alerts (zone_id, tenant_id) WHERE zone_id IS NOT NULL;
