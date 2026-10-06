-- 002: tenants, vehículos y dispositivos.
--
-- Todo dato pertenece a un tenant (regla 4). El aislamiento entre tenants se apoya en la base donde se puede:
-- las claves foráneas compuestas impiden que una fila apunte a un padre de otro tenant.
--
-- Permisos: los privilegios por defecto de la 001 dan DML a fleet_app y SELECT a fleet_ro sobre estas tablas.
--
-- Reversión: ver 002_tenants_vehicles_devices.down.sql (solo en local).

CREATE TABLE tenants (
  id         uuid        PRIMARY KEY,
  name       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenants_name_key UNIQUE (name)
);

CREATE TABLE vehicles (
  id         uuid        PRIMARY KEY,
  tenant_id  uuid        NOT NULL REFERENCES tenants (id),
  -- Placa: dato personal (Ley 1581). Nunca en logs (REDACTED_KEYS del logger).
  plate      text        NOT NULL,
  label      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Una placa es única dentro de un tenant, no entre tenants.
  CONSTRAINT vehicles_tenant_plate_key UNIQUE (tenant_id, plate),
  -- Objetivo de la FK compuesta de devices: `id` ya es único, pero una FK compuesta necesita un índice único
  -- exactamente sobre (id, tenant_id).
  CONSTRAINT vehicles_id_tenant_key UNIQUE (id, tenant_id)
);

CREATE TABLE devices (
  id         uuid        PRIMARY KEY,
  tenant_id  uuid        NOT NULL,
  vehicle_id uuid        NOT NULL,
  -- sha256 del token completo (`fdt_...`) en hexadecimal minúscula. El token en claro nunca se guarda.
  -- Único entre TODOS los dispositivos, también los revocados: un token revocado no puede reaparecer.
  token_hash text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CONSTRAINT devices_token_hash_key UNIQUE (token_hash),
  CONSTRAINT devices_token_hash_format CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  -- Un dispositivo no puede apuntar al vehículo de otro tenant: el par (vehicle_id, tenant_id) debe existir en vehicles.
  CONSTRAINT devices_vehicle_tenant_fkey FOREIGN KEY (vehicle_id, tenant_id) REFERENCES vehicles (id, tenant_id)
);

-- Autenticación del gateway: busca por hash entre los no revocados. INCLUDE devuelve la identidad sin leer la tabla
-- (index-only scan). El índice es parcial, así que un dispositivo revocado ni siquiera aparece en la búsqueda.
CREATE INDEX devices_active_token_hash_idx ON devices (token_hash) INCLUDE (id, tenant_id, vehicle_id) WHERE revoked_at IS NULL;

-- Dispositivos de un vehículo (rotación de token) y comprobación de la FK compuesta al borrar o cambiar un vehículo.
CREATE INDEX devices_vehicle_tenant_idx ON devices (vehicle_id, tenant_id);
