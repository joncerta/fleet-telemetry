import { NORTE_USER } from "./support/env";
import {
  alertList,
  connectionStatus,
  expect,
  login,
  NORTE_ALERT,
  NORTE_LIVE,
  openPanel,
  panelToggle,
  sendUntilShown,
  test,
  vehicleItem,
  vehicleList,
} from "./support/fixtures";

test("paneles desplegables: abrir y cerrar mantiene el contador visible y la preferencia sobrevive a recargar", async ({ page, env, fleet }) => {
  await fleet.send(NORTE_LIVE, { speedMps: 5 });
  await login(page, NORTE_USER, env.SEED_USER_PASSWORD);
  await expect(connectionStatus(page)).toContainText("En vivo");

  // Por defecto: Alertas abierto y Vehículos cerrado, pero con su contador a la vista.
  const alerts = panelToggle(page, "Alertas en vivo");
  const vehicles = panelToggle(page, "Vehículos");
  await expect(alerts).toHaveAttribute("aria-expanded", "true");
  await expect(vehicles).toHaveAttribute("aria-expanded", "false");
  await expect(vehicles).toHaveText(/^Vehículos\s*· \d+ con datos/);
  await expect(vehicleList(page)).toHaveCount(0);

  // Abrir con el teclado (Enter sobre el encabezado enfocado) muestra la lista y no pierde el foco.
  await vehicles.focus();
  await page.keyboard.press("Enter");
  await expect(vehicles).toHaveAttribute("aria-expanded", "true");
  await expect(vehicles).toBeFocused();
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

test("alertas con paneles plegados: se anuncian cerradas, elegir una abre Vehículos y al resolverse pasa al historial sin perder el foco", async ({
  page,
  env,
  fleet,
}) => {
  // Un punto real primero: resuelve cualquier "ubicación simulada" que haya dejado abierta otra corrida.
  await fleet.send(NORTE_ALERT, { mocked: false, speedMps: 5 });
  try {
    await login(page, NORTE_USER, env.SEED_USER_PASSWORD);
    await expect(connectionStatus(page)).toContainText("En vivo");
    await openPanel(page, "Vehículos");
    // La tubería en vivo ya entrega eventos de este vehículo.
    await sendUntilShown(page, fleet, NORTE_ALERT, { mocked: false, speedMps: 7.5 }, "27 km/h");

    // Con Vehículos y Alertas CERRADOS, una alerta nueva se anuncia igual en la región aria-live.
    const vehicles = panelToggle(page, "Vehículos");
    const alerts = panelToggle(page, "Alertas en vivo");
    await vehicles.click();
    await alerts.click();
    await expect(vehicles).toHaveAttribute("aria-expanded", "false");
    await expect(alerts).toHaveAttribute("aria-expanded", "false");
    await fleet.send(NORTE_ALERT, { mocked: true, speedMps: 7.5 });
    await expect(page.locator('[aria-live="polite"]').filter({ hasText: `Nueva alerta: Ubicación simulada, ${NORTE_ALERT}.` })).toHaveCount(1);
    await expect(alerts).toHaveText(/\d+ activas/);

    // Elegir la alerta selecciona el vehículo: Vehículos (cerrado) se abre y su fila queda marcada como seleccionada.
    await alerts.click();
    const activeRow = alertList(page).getByRole("listitem").filter({ hasText: `Ubicación simulada · ${NORTE_ALERT}` }).filter({ hasText: "Activa" });
    await activeRow.getByRole("button").click();
    await expect(vehicles).toHaveAttribute("aria-expanded", "true");
    await expect(vehicleItem(page, NORTE_ALERT).getByRole("button")).toHaveAttribute("aria-pressed", "true");

    // Al resolverse, la fila (que tiene el foco) pasa al historial cerrado: el foco vuelve al encabezado del panel, no cae a body.
    await fleet.send(NORTE_ALERT, { mocked: false, speedMps: 5 });
    await expect(alerts).toBeFocused();
    const history = page.getByRole("button", { name: /^Historial/ });
    await expect(history).toHaveAttribute("aria-expanded", "false");
    await history.click();
    await expect(history).toHaveAttribute("aria-expanded", "true");
    const resolved = page.getByRole("list", { name: "Historial resuelto" });
    await expect(resolved).toBeVisible();
    await expect(resolved.getByRole("listitem").filter({ hasText: `Ubicación simulada · ${NORTE_ALERT}` }).first()).toContainText("Resuelta");
  } finally {
    await fleet.send(NORTE_ALERT, { mocked: false, speedMps: 5 }).catch(() => undefined);
  }
});
