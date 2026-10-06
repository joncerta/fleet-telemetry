import { z } from "zod";
import type { TenantUserReader } from "../application/ports.js";

/** Lo único que hace falta del pool de `pg`. */
export interface TenantUsersQueryable {
  query(sql: string, params: unknown[]): Promise<{ rows: unknown[] }>;
}

// Parametrizada, con LIMIT y filtrada por el tenant de la sesión. `users` no es una hypertable. NO selecciona `password_hash`: ni siquiera
// llega al proceso. Ni la sentencia ni sus parámetros se registran (nombre y correo son datos personales).
const LIST_USERS = `
SELECT user_id, name, email, created_at
  FROM users
 WHERE tenant_id = $1
 ORDER BY name, user_id
 LIMIT $2`;

const userRow = z.object({ user_id: z.uuid(), name: z.string().min(1), email: z.string().min(1), created_at: z.date() });

/** Adaptador de `TenantUserReader` sobre Postgres (rol `fleet_app`). Los errores de `pg` se propagan: nunca llegan al cliente. */
export function createPgTenantUserReader(pool: TenantUsersQueryable): TenantUserReader {
  return {
    async listUsers(tenantId, limit) {
      const { rows } = await pool.query(LIST_USERS, [tenantId, limit]);
      return rows.map((row) => {
        const user = userRow.parse(row);
        return { userId: user.user_id, name: user.name, email: user.email, createdAt: user.created_at.toISOString() };
      });
    },
  };
}
