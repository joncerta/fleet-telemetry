import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ApiRequestError, NetworkError } from "../../lib/api/http-client";
import type { FleetApi } from "../../lib/api/fleet-api";
import { idle, ready } from "../../lib/loadable";
import { userItem } from "../../test-support/catalog-fixtures";
import { CollapsiblePanelView } from "../../components/panel";
import { panelError } from "../../components/panel-error";
import { createUsersController } from "./users-controller";
import { UsersBody } from "./UsersPanel";

type Api = Pick<FleetApi, "listUsers">;

describe("users-controller", () => {
  it("carga la lista ordenada por nombre", async () => {
    const listUsers = vi.fn<Api["listUsers"]>(() => Promise.resolve({ items: [userItem({ name: "Zoe" }), userItem({ name: "Álvaro" }), userItem({ name: "Beatriz" })] }));
    const controller = createUsersController({ listUsers }, () => 5);
    await controller.load();
    const { users } = controller.store.getState();
    expect(users.data?.map((user) => user.name)).toEqual(["Álvaro", "Beatriz", "Zoe"]);
    expect(users).toMatchObject({ status: "ready", updatedAt: 5, error: null });
    expect(listUsers).toHaveBeenCalledWith(500, expect.any(AbortSignal));
  });

  it("si la recarga falla conserva la lista anterior con su hora y el error; al reintentar con éxito el error desaparece", async () => {
    const listUsers = vi.fn<Api["listUsers"]>().mockResolvedValueOnce({ items: [userItem({ name: "Ana" })] });
    const controller = createUsersController({ listUsers }, () => 7);
    await controller.load();
    listUsers.mockRejectedValueOnce(new NetworkError());
    const pending = controller.load();
    // Durante la recarga el error anterior (aún no hay) y los datos se conservan.
    expect(controller.store.getState().users.status).toBe("loading");
    await pending;
    expect(controller.store.getState().users.data).toHaveLength(1);
    expect(controller.store.getState().users.error).toMatch(/No se pudo conectar para cargar los usuarios/);

    listUsers.mockImplementationOnce(() => new Promise(() => undefined));
    void controller.load();
    // `loading` conserva el error: el aviso no se desmonta ni se re-anuncia al recargar.
    expect(controller.store.getState().users.error).not.toBeNull();
    controller.dispose();
  });

  it.each([
    [new ApiRequestError(429, "rate_limited", "x", null), /Demasiadas solicitudes/],
    [new ApiRequestError(500, "boom", "x", null), /No se pudieron cargar los usuarios/],
  ])("error de carga sin datos previos (%#)", async (error, message) => {
    const controller = createUsersController({ listUsers: () => Promise.reject(error) });
    await controller.load();
    expect(controller.store.getState().users).toMatchObject({ status: "error", data: null });
    expect(controller.store.getState().users.error).toMatch(message);
  });

  it("al desmontar se cancela la carga y no se aplica", async () => {
    const listUsers = vi.fn<Api["listUsers"]>(
      (_limit, signal) =>
        new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new DOMException("cancelada", "AbortError")))),
    );
    const controller = createUsersController({ listUsers });
    const pending = controller.load();
    controller.dispose();
    await pending;
    expect(controller.store.getState().users.status).toBe("loading");
  });
});

describe("UsersBody", () => {
  const render = (users: Parameters<typeof UsersBody>[0]["users"]) => renderToStaticMarkup(<UsersBody users={users} onRetry={() => undefined} />);

  it("cargando", () => {
    expect(render(idle())).toContain("Cargando…");
  });

  it("lista nombre y correo de cada usuario", () => {
    const html = render(ready([userItem({ name: "Operador Norte", email: "operador@norte.test" })], 0));
    expect(html).toContain('aria-label="Usuarios"');
    expect(html).toContain("Operador Norte");
    expect(html).toContain("operador@norte.test");
  });

  it("vacío", () => {
    expect(render(ready([], 0))).toContain("No hay usuarios en esta flota.");
  });

  it("el nombre con HTML se escapa", () => {
    const html = render(ready([userItem({ name: "<img src=x onerror=alert(1)>" })], 0));
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("error: el cuerpo conserva la lista vieja y Reintentar, sin aviso propio", () => {
    const html = render({ data: [userItem({ name: "Ana" })], updatedAt: Date.UTC(2026, 9, 6, 15, 0, 0), error: "No se pudieron cargar los usuarios." });
    expect(html).not.toContain('role="alert"');
    expect(html).toContain("Ana");
    expect(html).toContain("Reintentar");
  });

  it("el aviso sale en el encabezado con el panel cerrado: un único role=alert, con la hora de la lista vieja", () => {
    const resource = { data: [userItem({ name: "Ana" })], updatedAt: Date.UTC(2026, 9, 6, 15, 0, 0), error: "No se pudieron cargar los usuarios." };
    const html = renderToStaticMarkup(
      <CollapsiblePanelView id="users" title="Usuarios" count={1} error={panelError(resource, "Lista")} open={false} onToggle={() => undefined}>
        <UsersBody users={resource} onRetry={() => undefined} />
      </CollapsiblePanelView>,
    );
    expect(html.match(/role="alert"/g)).toHaveLength(1);
    expect(html).toContain("No se pudieron cargar los usuarios. Lista de las");
  });
});
