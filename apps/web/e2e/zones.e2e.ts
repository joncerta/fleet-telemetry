import { randomBytes } from "node:crypto";
import type { Page } from "@playwright/test";
import { deleteE2eZones, uniqueE2eZoneName } from "./support/cleanup";
import { NORTE_USER, SUR_USER } from "./support/env";
import { connectionStatus, expandAll, expect, login, openIsolatedPage, openPanel, test } from "./support/fixtures";

/** Cuatro clics sobre el lienzo del mapa (un cuadrado alrededor del centro, que es Bogotá). */
async function drawSquare(page: Page): Promise<void> {
  // El lienzo se nombra "Mapa de la flota" (locale de MapLibre); `and` lo distingue de su contenedor.
  const canvas = page.getByLabel("Mapa de la flota").and(page.locator("canvas"));
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
    // Alternativa con teclado: un punto en el centro del mapa (la cruz); se deshace para dibujar con el puntero.
    await panel.getByRole("button", { name: "Agregar punto en el centro del mapa" }).click();
    await expect(panel.getByText(/1 punto/)).toBeVisible();
    await panel.getByRole("button", { name: "Deshacer punto" }).click();
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
    await expect(panel.getByRole("status").filter({ hasText: `Zona «${name}» creada.` })).toBeVisible();
    // Tras guardar, el foco vuelve a "Nueva zona".
    await expect(panel.getByRole("button", { name: "Nueva zona" })).toBeFocused();

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
    // Ancla: una zona propia de Sur ya cargada; sin ella, "no aparece" podría ser solo "aún no cargó".
    await expect(sur.page.getByRole("list", { name: "Zonas" }).getByText("Zona crítica Sur 1")).toBeVisible();
    await expect(sur.page.getByText(name)).toHaveCount(0);
  } finally {
    await norte.context.close();
    await sur.context.close();
    await deleteE2eZones(env, [name]);
  }
});

test("zonas: al cerrar sesión Norte y entrar Sur en la misma pestaña, la zona de Norte no se ve y se puede dibujar de nuevo", async ({ browser, baseURL, env, stack: _stack }) => {
  const name = uniqueE2eZoneName(randomBytes(4).toString("hex"));
  const shared = await openIsolatedPage(browser, baseURL);
  const { page } = shared;
  try {
    await login(page, NORTE_USER, env.SEED_USER_PASSWORD);
    await expect(connectionStatus(page)).toContainText("En vivo");
    await openPanel(page, "Zonas");
    const panel = page.getByRole("region", { name: /^Zonas/ });
    await panel.getByRole("button", { name: "Nueva zona" }).click();
    await drawSquare(page);
    await panel.getByRole("button", { name: "Cerrar polígono" }).click();
    const form = panel.getByRole("form", { name: "Nueva zona" });
    await form.getByLabel("Nombre").fill(name);
    await form.getByRole("button", { name: "Guardar" }).click();
    await expect(panel.getByRole("list", { name: "Zonas" }).getByText(name)).toBeVisible();
    // Un dibujo a medias al cerrar sesión no debe sobrevivir al siguiente usuario.
    await panel.getByRole("button", { name: "Nueva zona" }).click();
    await drawSquare(page);

    await page.getByRole("button", { name: "Cerrar sesión" }).click();
    await login(page, SUR_USER, env.SEED_USER_PASSWORD);
    await expect(connectionStatus(page)).toContainText("En vivo");
    await openPanel(page, "Zonas");
    const surPanel = page.getByRole("region", { name: /^Zonas/ });
    await expect(surPanel.getByRole("list", { name: "Zonas" }).getByText("Zona crítica Sur 1")).toBeVisible();
    await expect(page.getByText(name)).toHaveCount(0);
    // Sin dibujo heredado y "Nueva zona" operable (no trabado).
    await surPanel.getByRole("button", { name: "Nueva zona" }).click();
    await expect(surPanel.getByText(/Haz clic en el mapa para agregar vértices/)).toBeVisible();
    await expect(surPanel.getByText(/0 puntos/)).toBeVisible();
  } finally {
    await shared.context.close();
    await deleteE2eZones(env, [name]);
  }
});
