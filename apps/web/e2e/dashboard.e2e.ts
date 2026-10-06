import { NORTE_USER } from "./support/env";
import {
  alertList,
  connectionStatus,
  expect,
  login,
  openPanel,
  NORTE_ALERT,
  NORTE_LIVE,
  sendUntilShown,
  test,
  vehicleItem,
  vehicleList,
} from "./support/fixtures";

test.describe("dashboard en vivo (Flota Norte)", () => {
  test("login con Norte: se ven sus vehículos y llegan actualizaciones en vivo sin recargar", async ({ page, env, fleet }) => {
    // Un punto antes de entrar: el snapshot ya trae el vehículo.
    await fleet.send(NORTE_LIVE, { speedMps: 12.5 });
    await login(page, NORTE_USER, env.SEED_USER_PASSWORD);

    await expect(connectionStatus(page)).toContainText("En vivo");
    await openPanel(page, "Vehículos");
    // El mapa cargó (estilo y WebGL: la leyenda solo aparece con el mapa listo) y dibujó la capa de vehículos (la procesa el worker de
    // MapLibre: si el worker no arranca, la capa nunca termina de cargar).
    const map = page.getByRole("main", { name: "Mapa" });
    await expect(map.getByText("Leyenda")).toBeVisible();
    // El lienzo ocupa todo su panel: con el contenedor en altura 0 el mapa "carga" igual pero queda recortado e invisible
    // (`toBeVisible` no ve el recorte, por eso se comparan las alturas).
    const canvas = map.getByRole("region", { name: "Mapa de la flota" });
    await expect(canvas).toBeVisible();
    const panelHeight = (await map.boundingBox())?.height ?? 0;
    expect(panelHeight).toBeGreaterThan(200);
    await expect.poll(async () => (await canvas.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(panelHeight - 1);
    await expect(map.getByText("Cargando vehículos…")).toHaveCount(0);
    await expect(map.getByText("No se pudieron dibujar los vehículos en el mapa", { exact: false })).toHaveCount(0);
    await expect(map.getByText("No se pudo mostrar el mapa", { exact: false })).toHaveCount(0);
    await expect(vehicleItem(page, NORTE_LIVE)).toBeVisible();
    // Solo vehículos de Norte en la lista.
    await expect(vehicleList(page).getByRole("listitem").filter({ hasText: /SUR\d{3}/ })).toHaveCount(0);

    // En vivo: las actualizaciones cambian la velocidad mostrada sin recargar.
    await sendUntilShown(page, fleet, NORTE_LIVE, { speedMps: 15 }, "54 km/h");
    await fleet.send(NORTE_LIVE, { speedMps: 20 });
    await expect(vehicleItem(page, NORTE_LIVE)).toContainText("72 km/h");

    // KPIs de /v1/summary.
    const kpis = page.getByRole("region", { name: "Resumen de la flota" });
    await expect(kpis.getByText("Total")).toBeVisible();
    await expect(kpis.getByText("Alertas activas")).toBeVisible();
  });

  test("una alerta nueva aparece sin recargar", async ({ page, env, fleet }) => {
    // Un punto real primero: resuelve cualquier "ubicación simulada" que haya dejado abierta otra corrida.
    await fleet.send(NORTE_ALERT, { mocked: false, speedMps: 5 });
    await login(page, NORTE_USER, env.SEED_USER_PASSWORD);
    await expect(connectionStatus(page)).toContainText("En vivo");
    await openPanel(page, "Vehículos");
    // La tubería en vivo ya entrega eventos de este vehículo.
    await sendUntilShown(page, fleet, NORTE_ALERT, { mocked: false, speedMps: 7.5 }, "27 km/h");

    const activeMocked = alertList(page).getByRole("listitem").filter({ hasText: `Ubicación simulada · ${NORTE_ALERT}` }).filter({ hasText: "Activa" });
    await expect(activeMocked).toHaveCount(0);

    await fleet.send(NORTE_ALERT, { mocked: true, speedMps: 7.5 });
    await expect(activeMocked).toHaveCount(1);
  });
});
