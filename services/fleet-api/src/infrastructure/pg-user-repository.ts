import type { Session } from "@fleet/contracts";
import { z } from "zod";
import type { UserAccount, UserRepository } from "../application/ports.js";
import type { AuthIdentity } from "../domain/identity.js";

/** Lo único que hace falta del pool de `pg`. */
export interface UserQueryable {
  query(sql: string, params: unknown[]): Promise<{ rows: unknown[] }>;
}

const userRow = z.object({
  user_id: z.uuid(),
  tenant_id: z.uuid(),
  email: z.string().min(1),
  name: z.string().min(1),
  password_hash: z.string().min(1),
  tenant_name: z.string().min(1),
});

// Parametrizadas. `users` y `tenants` no son hypertables (no hay rango de tiempo) y devuelven a lo sumo una fila (LIMIT 1).
// El login NO lleva filtro de tenant: esta consulta es la que DERIVA el tenant del correo (índice único `users_email_lower_key`
// sobre lower(email), migración 006). El perfil de la sesión, en cambio, filtra por usuario Y tenant de la identidad verificada.
const SELECT_USER = `
SELECT u.user_id, u.tenant_id, u.email, u.name, u.password_hash, t.name AS tenant_name
  FROM users u
  JOIN tenants t ON t.id = u.tenant_id`;

const FIND_BY_EMAIL = `${SELECT_USER} WHERE lower(u.email) = lower($1) LIMIT 1`;
const FIND_PROFILE = `${SELECT_USER} WHERE u.user_id = $1 AND u.tenant_id = $2 LIMIT 1`;

/**
 * Adaptador de `UserRepository` sobre Postgres (rol `fleet_app`). Los errores de `pg` se propagan tal cual al llamador, que nunca
 * los envía al cliente. El correo y el hash de la contraseña son datos personales / secretos: no se registran.
 */
export function createPgUserRepository(pool: UserQueryable): UserRepository {
  return {
    async findByEmail(email): Promise<UserAccount | null> {
      const { rows } = await pool.query(FIND_BY_EMAIL, [email]);
      const [row] = rows;
      if (row === undefined) return null;
      const user = userRow.parse(row);
      return {
        userId: user.user_id,
        tenantId: user.tenant_id,
        email: user.email,
        name: user.name,
        passwordHash: user.password_hash,
        tenantName: user.tenant_name,
      };
    },

    async findProfile(identity: AuthIdentity): Promise<Session | null> {
      const { rows } = await pool.query(FIND_PROFILE, [identity.userId, identity.tenantId]);
      const [row] = rows;
      if (row === undefined) return null;
      const user = userRow.parse(row);
      return {
        user: { userId: user.user_id, email: user.email, name: user.name },
        tenant: { tenantId: user.tenant_id, name: user.tenant_name },
      };
    },
  };
}
