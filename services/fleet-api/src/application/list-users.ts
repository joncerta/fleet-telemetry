import type { UserListResponse } from "@fleet/contracts";
import type { TenantUserReader } from "./ports.js";

export type ListUsers = (input: { tenantId: string; limit: number }) => Promise<UserListResponse>;

/** Usuarios del tenant, por nombre. Solo lectura. El tenant lo fija quien llama con la identidad de la sesión. */
export function createListUsers(deps: { users: TenantUserReader }): ListUsers {
  return async ({ tenantId, limit }) => ({ items: await deps.users.listUsers(tenantId, limit) });
}
