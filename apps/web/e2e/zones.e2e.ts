import { randomBytes } from "node:crypto";
import type { Page } from "@playwright/test";
import { deleteE2eZones, uniqueE2eZoneName } from "./support/cleanup";
import { NORTE_USER, SUR_USER } from "./support/env";
import { connectionStatus, expandAll, expect, login, openIsolatedPage, openPanel, test } from "./support/fixtures";

/** Cuatro clics sobre el lienzo del mapa (un cuadrado alrededor del centro, que es Bogotá). */
async function drawSquare(page: Page): Promise<void> {
  const canvas = page.getByRole("main", { name: "Mapa" }).locator("canvas").first();
  const box = await canvas.boundingBox();
  if (box === null) throw new Error("El mapa no tiene tamaño");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  for (const [dx, dy] of [
    [-80, -80],
    [80, -80],
    [80, 80],
    [-80, 80],
  ] as const) {
    await page.mouse.click(cx + dx, cy + dy);
  }
}

test("zonas: dibujar un polígono, nombrarlo y guardarlo; nombre repetido da error; Sur no ve la zona de Norte", async ({ browser, baseURL, env, stack: _stack }) => {
  const name = uniqueE2eZoneName(randomBytes(4).toString("hex"));
  const norte = await openIsolatedPage(browser, baseURL);
  const sur = await openIsolatedPage(browser, baseURL);
  try {
    await login(norte.page, NORTE_USER, env.SEED_USER_PASSWORD);
    await expect(connectionStatus(norte.page)).toContainText("En vivo");
    await openPanel(norte.page, "Zonas");
    const panel = norte.page.getByRole("region", { name: /^Zonas/ });

    await panel.getByRole("button", { name: "Nueva zona" }).click();
    await expect(panel.getByText(/Haz clic en el mapa para agregar vértices/)).toBeVisible();
    await drawSquare(norte.page);
    await expect(panel.getByText(/4 puntos/)).toBeVisible();
    await panel.getByRole("button", { name: "Cerrar polígono" }).click();

    // Guardar vacío: error del campo, con el foco.
    const form = panel.getByRole("form", { name: "Nueva zona" });
    await form.getByRole("button", { name: "Guardar" }).click();
    await expect(form.getByLabel("Nombre")).toHaveAttribute("aria-invalid", "true");
    await expect(form.getByLabel("Nombre")).toBeFocused();

    await form.getByLabel("Nombre").fill(name);
    await form.getByLabel("Tipo").selectOption({ label: "Depósito" });
    await form.getByRole("button", { name: "Guardar" }).click();
    const list = panel.getByRole("list", { name: "Zonas" });
    await expect(list.getByRole("listitem").filter({ hasText: name })).toContainText("Depósito");

    // Mismo nombre otra vez: 409, error en el campo y el polígono sigue ahí para corregir el nombre.
    await panel.getByRole("button", { name: "Nueva zona" }).click();
    await drawSquare(norte.page);
    await panel.getByRole("button", { name: "Cerrar polígono" }).click();
    await form.getByLabel("Nombre").fill(name);
    await form.getByRole("button", { name: "Guardar" }).click();
    await expect(form.getByLabel("Nombre")).toHaveAttribute("aria-invalid", "true");
    await expect(form.getByText("Ya existe una zona con ese nombre.")).toBeVisible();
    await panel.getByRole("button", { name: "Cancelar" }).click();
    await expect(list.getByRole("listitem").filter({ hasText: name })).toHaveCount(1);

    // Sur no ve la zona de Norte en ningún panel.
    await login(sur.page, SUR_USER, env.SEED_USER_PASSWORD);
    await expect(connectionStatus(sur.page)).toContainText("En vivo");
    await expandAll(sur.page);
    await expect(sur.page.getByText(name)).toHaveCount(0);
  } finally {
    await norte.context.close();
    await sur.context.close();
    await deleteE2eZones(env, [name]);
  }
});
