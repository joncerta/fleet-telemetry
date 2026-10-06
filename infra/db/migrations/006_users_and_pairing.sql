-- 006: usuarios del portal y códigos de vinculación de dispositivos (fase 1b).
--
-- Los usuarios inician sesión en fleet-api (cookie firmada). El `tenant_id` de toda consulta sale de la sesión, que sale de esta
-- tabla: nunca del cliente (regla 4). Los códigos de vinculación los crea un operador para un vehículo de SU tenant y el móvil los
-- canjea una vez por un token de dispositivo (ver `device_pairing_codes`).
--
-- Datos personales (Ley 1581): email y nombre. Nunca en logs. La contraseña no se guarda: solo su hash.
--
-- Permisos: los privilegios por defecto de la 001 dan DML a fleet_app y SELECT a fleet_ro.
--
-- Reversión: ver 006_users_and_pairing.down.sql (solo en local).

CREATE TABLE users (
  user_id       uuid        PRIMARY KEY,
  tenant_id     uuid        NOT NULL REFERENCES tenants (id),
  email         text        NOT NULL,
  name          text        NOT NULL,
  -- scrypt de `node:crypto` con sus parámetros codificados en el propio hash, para poder subirlos sin invalidar los existentes:
  --   scrypt$<N>$<r>$<p>$<sal en base64url>$<derivación en base64url>
  -- (`hashPassword` y `verifyPassword` de @fleet/platform). La contraseña en claro nunca llega a la base.
  password_hash text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_password_hash_format CHECK (password_hash ~ '^scrypt\$[1-9][0-9]*\$[1-9][0-9]*\$[1-9][0-9]*\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$'),
  -- Objetivo de la FK compuesta de `device_pairing_codes.created_by`.
  CONSTRAINT users_user_tenant_key UNIQUE (user_id, tenant_id)
);

-- El correo es único SIN distinguir mayúsculas y entre todos los tenants: el login recibe solo correo y contraseña, y de ahí sale el
-- tenant. Se busca con `WHERE lower(email) = lower($1)`, que usa este índice.
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));

CREATE INDEX users_tenant_idx ON users (tenant_id);

-- Códigos de vinculación: de un solo uso y corta vida. Solo se guarda el sha256 (hexadecimal minúscula) del código, igual que
-- `devices.token_hash`: un volcado de la tabla no revela códigos canjeables. El canje marca `used_at` y emite el token del dispositivo
-- en la misma transacción.
CREATE TABLE device_pairing_codes (
  code_hash  text        PRIMARY KEY,
  tenant_id  uuid        NOT NULL,
  vehicle_id uuid        NOT NULL,
  created_by uuid        NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT device_pairing_codes_code_hash_format CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  -- El vehículo debe ser del mismo tenant que el código, y el usuario que lo creó también.
  CONSTRAINT device_pairing_codes_vehicle_tenant_fkey FOREIGN KEY (vehicle_id, tenant_id) REFERENCES vehicles (id, tenant_id),
  CONSTRAINT device_pairing_codes_created_by_tenant_fkey FOREIGN KEY (created_by, tenant_id) REFERENCES users (user_id, tenant_id)
);

-- Comprobación de las FK compuestas y códigos de un vehículo.
CREATE INDEX device_pairing_codes_vehicle_tenant_idx ON device_pairing_codes (vehicle_id, tenant_id);
CREATE INDEX device_pairing_codes_created_by_tenant_idx ON device_pairing_codes (created_by, tenant_id);

-- Limpieza de códigos vencidos o usados.
CREATE INDEX device_pairing_codes_expires_idx ON device_pairing_codes (expires_at);
