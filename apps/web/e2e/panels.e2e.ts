import { NORTE_USER } from "./support/env";
import { connectionStatus, expect, login, NORTE_LIVE, panelToggle, test, vehicleList } from "./support/fixtures";

test("paneles desplegables: abrir y cerrar mantiene el contador visible y la preferencia sobrevive a recargar", async ({ page, env, fleet }) => {
  await fleet.send(NORTE_LIVE, { speedMps: 5 });
  await login(page, NORTE_USER, env.SEED_USER_PASSWORD);
  await expect(connectionStatus(page)).toContainText("En vivo");

  // Por defecto: Alertas abierto y Vehículos cerrado, pero con su contador a la vista.
  const alerts = panelToggle(page, "Alertas en vivo");
  const vehicles = panelToggle(page, "Vehículos");
  await expect(alerts).toHaveAttribute("aria-expanded", "true");
  await expect(vehicles).toHaveAttribute("aria-expanded", "false");
  await expect(vehicles).toHaveText(/^Vehículos\s*· \d+/);
  await expect(vehicleList(page)).toHaveCount(0);

  // Abrir con el teclado (Enter sobre el encabezado enfocado) muestra la lista.
  await vehicles.focus();
  await page.keyboard.press("Enter");
  await expect(vehicles).toHaveAttribute("aria-expanded", "true");
  await expect(vehicleList(page)).toBeVisible();

  // Cerrar Alertas: el contador sigue visible y las alertas se ocultan.
  await alerts.click();
  await expect(alerts).toHaveAttribute("aria-expanded", "false");
  await expect(alerts).toHaveText(/^Alertas en vivo\s*· \d+ activas/);
  await expect(page.getByRole("list", { name: "Alertas" })).toHaveCount(0);

  // Recargar conserva ambas decisiones.
  await page.reload();
  await expect(connectionStatus(page)).toContainText("En vivo");
  await expect(panelToggle(page, "Alertas en vivo")).toHaveAttribute("aria-expanded", "false");
  await expect(panelToggle(page, "Vehículos")).toHaveAttribute("aria-expanded", "true");
  await expect(vehicleList(page)).toBeVisible();
});
