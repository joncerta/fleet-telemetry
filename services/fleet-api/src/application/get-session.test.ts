import { randomUUID } from "node:crypto";
import type { Session } from "@fleet/contracts";
import { describe, expect, it, vi } from "vitest";
import { SessionInvalidError } from "./errors.js";
import { createGetSession } from "./get-session.js";

const identity = { userId: randomUUID(), tenantId: randomUUID() };
const session: Session = {
  user: { userId: identity.userId, email: "operador@norte.test", name: "Operador" },
  tenant: { tenantId: identity.tenantId, name: "Flota Norte" },
};

describe("createGetSession", () => {
  it("devuelve la sesión de la identidad, buscándola por usuario Y tenant", async () => {
    const findProfile = vi.fn().mockResolvedValue(session);

    await expect(createGetSession({ users: { findByEmail: vi.fn(), findProfile } })(identity)).resolves.toEqual(session);

    expect(findProfile).toHaveBeenCalledWith(identity);
  });

  it("si el usuario ya no existe lanza SessionInvalidError", async () => {
    const users = { findByEmail: vi.fn(), findProfile: vi.fn().mockResolvedValue(null) };

    await expect(createGetSession({ users })(identity)).rejects.toBeInstanceOf(SessionInvalidError);
  });
});
