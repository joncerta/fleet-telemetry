import type { Page } from "@playwright/test";
import { NORTE_USER, SUR_USER } from "./support/env";
import {
  alertList,
  connectionStatus,
  expect,
  login,
  NORTE_ISOLATION,
  openIsolatedPage,
  openPanel,
  sendUntilShown,
  SUR_LIVE,
  test,
  vehicleItem,
  vehicleList,
} from "./support/fixtures";

/** Lo de Norte (placas NRTnnn) que Sur podría estar mostrando: la lista, las alertas o cualquier parte de la pantalla. */
const norteVisibleIn = (page: Page) => ({
  vehicles: vehicleList(page).getByRole("listitem").filter({ hasText: /NRT\d{3}/ }),
  alerts: alertList(page).getByRole("listitem").filter({ hasText: /NRT\d{3}/ }),
  anywhere: page.getByText(/NRT\d{3}/),
});

test("aislamiento: Norte y Sur logueados a la vez; lo de Norte llega a Norte y nunca aparece en Sur (stream, snapshot y REST)", async ({
  browser,
  baseURL,
  env,
  fleet,
}) => {
  const norte = await openIsolatedPage(browser, baseURL);
  const sur = await openIsolatedPage(browser, baseURL);
  try {
    await fleet.send(SUR_LIVE, { speedMps: 5 });
    await fleet.send(NORTE_ISOLATION, { mocked: false, speedMps: 5 });
    await login(norte.page, NORTE_USER, env.SEED_USER_PASSWORD);
    await login(sur.page, SUR_USER, env.SEED_USER_PASSWORD);
    await expect(connectionStatus(norte.page)).toContainText("En vivo");
    await expect(connectionStatus(sur.page)).toContainText("En vivo");
    await openPanel(norte.page, "Vehículos");
    await openPanel(sur.page, "Vehículos");

    // Prueba positiva 1: Sur sí recibe lo suyo por el stream (su conexión funciona, así que un "0 de Norte" significa algo).
    await sendUntilShown(sur.page, fleet, SUR_LIVE, { speedMps: 10 }, "36 km/h");

    // Prueba positiva 2: Norte VE su evento (el vehículo por SSE y su alerta).
    await sendUntilShown(norte.page, fleet, NORTE_ISOLATION, { mocked: false, speedMps: 8 }, "29 km/h");
    await fleet.send(NORTE_ISOLATION, { mocked: true, speedMps: 9 });
    const mockedAlert = alertList(norte.page)
      .getByRole("listitem")
      .filter({ hasText: `Ubicación simulada · ${NORTE_ISOLATION}` })
      // La base acumula el historial de corridas anteriores (resueltas, y la lista muestra las últimas 50): solo cuenta la alerta ACTIVA,
      // que es la de esta corrida porque los puntos reales de arriba (y del `finally` de la corrida previa) resolvieron cualquier otra.
      .filter({ hasText: "Activa" });
    await expect(mockedAlert).toHaveCount(1);

    // Recién ahora, con la prueba de que el evento de Norte ya se distribuyó, Sur no tiene nada de Norte.
    await expect(vehicleItem(sur.page, SUR_LIVE)).toBeVisible();
    await expect(norteVisibleIn(sur.page).vehicles).toHaveCount(0);
    await expect(norteVisibleIn(sur.page).alerts).toHaveCount(0);
    await expect(norteVisibleIn(sur.page).anywhere).toHaveCount(0);

    // Snapshot y REST: tras recargar, Sur vuelve a pedir todo y sigue sin ver nada de Norte.
    await sur.page.reload();
    await expect(connectionStatus(sur.page)).toContainText("En vivo");
    await expect(vehicleItem(sur.page, SUR_LIVE)).toBeVisible();
    await expect(norteVisibleIn(sur.page).vehicles).toHaveCount(0);
    await expect(norteVisibleIn(sur.page).alerts).toHaveCount(0);
    await expect(norteVisibleIn(sur.page).anywhere).toHaveCount(0);
  } finally {
    // Un punto real resuelve la alerta de ubicación simulada que dejó este test.
    await fleet.send(NORTE_ISOLATION, { mocked: false, speedMps: 5 }).catch(() => undefined);
    await norte.context.close();
    await sur.context.close();
  }
});

test("sesión compartida entre pestañas: si en otra pestaña (misma cookie) entra otro tenant, la pestaña vieja termina en /login sin datos del anterior", async ({
  browser,
  baseURL,
  env,
  fleet,
}) => {
  await fleet.send(NORTE_ISOLATION, { mocked: false, speedMps: 5 });
  const shared = await openIsolatedPage(browser, baseURL);
  try {
    const old = shared.page;
    await login(old, NORTE_USER, env.SEED_USER_PASSWORD);
    await expect(connectionStatus(old)).toContainText("En vivo");
    await openPanel(old, "Vehículos");
    await expect(vehicleItem(old, NORTE_ISOLATION)).toBeVisible();

    // Otra pestaña del MISMO contexto (misma cookie): cierra sesión y entra el usuario de Sur.
    const other = await shared.context.newPage();
    await other.goto("/");
    await expect(other.getByRole("heading", { level: 1, name: "Fleet Telemetry" })).toBeVisible();
    await other.getByRole("button", { name: "Cerrar sesión" }).click();
    await expect(other).toHaveURL(/\/login$/);
    await login(other, SUR_USER, env.SEED_USER_PASSWORD);
    await expect(connectionStatus(other)).toContainText("En vivo");

    // La pestaña vieja se entera por el canal entre pestañas: va al login y su pantalla ya no tiene nada de Norte.
    await expect(old).toHaveURL(/\/login$/);
    await expect(old.getByText(/NRT\d{3}/)).toHaveCount(0);
    await expect(other.getByText(/NRT\d{3}/)).toHaveCount(0);
  } finally {
    await shared.context.close();
  }
});
