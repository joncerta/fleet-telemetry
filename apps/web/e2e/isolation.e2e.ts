import { SUR_USER } from "./support/env";
import { alertList, connectionStatus, expect, login, NORTE_ISOLATION, sendUntilShown, SUR_LIVE, test, vehicleItem, vehicleList } from "./support/fixtures";

test("aislamiento: el usuario de Sur no ve los vehículos ni las alertas de Norte", async ({ page, env, fleet }) => {
  await fleet.send(SUR_LIVE, { speedMps: 5 });
  await login(page, SUR_USER, env.SEED_USER_PASSWORD);
  await expect(connectionStatus(page)).toContainText("En vivo");
  await expect(vehicleItem(page, SUR_LIVE)).toBeVisible();
  await sendUntilShown(page, fleet, SUR_LIVE, { speedMps: 10 }, "36 km/h");

  // Norte se mueve y levanta una alerta mientras Sur mira; después, Sur recibe su propia actualización.
  await fleet.send(NORTE_ISOLATION, { mocked: false, speedMps: 8 });
  await fleet.send(NORTE_ISOLATION, { mocked: true, speedMps: 9 });
  await fleet.send(SUR_LIVE, { speedMps: 25 });
  await expect(vehicleItem(page, SUR_LIVE)).toContainText("90 km/h");

  // Lo de Norte salió antes que la actualización de Sur que ya llegó: si se filtrara, ya estaría en pantalla.
  await expect(vehicleList(page).getByRole("listitem").filter({ hasText: /NRT\d{3}/ })).toHaveCount(0);
  await expect(alertList(page).getByRole("listitem").filter({ hasText: /NRT\d{3}/ })).toHaveCount(0);
  await expect(page.getByText(/NRT\d{3}/)).toHaveCount(0);
});
