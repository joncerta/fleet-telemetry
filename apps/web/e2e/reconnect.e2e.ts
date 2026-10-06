import { NORTE_USER } from "./support/env";
import { connectionStatus, expect, login, NORTE_LIVE, sendUntilShown, test, vehicleItem } from "./support/fixtures";

test("al reiniciar fleet-api, el dashboard se reconecta solo y recupera el estado", async ({ page, env, fleet, stack }) => {
  await fleet.send(NORTE_LIVE, { speedMps: 10 });
  await login(page, NORTE_USER, env.SEED_USER_PASSWORD);
  await expect(connectionStatus(page)).toContainText("En vivo");
  await sendUntilShown(page, fleet, NORTE_LIVE, { speedMps: 10 }, "36 km/h");

  const restarting = stack.restartFleetApi();
  // Mientras fleet-api está caído, el indicador lo dice (nunca "En vivo" con datos viejos).
  await expect(connectionStatus(page)).not.toContainText("En vivo");
  // Un punto mientras está caído: lo trae el snapshot de la reconexión (no hay evento en vivo que lo entregue).
  await fleet.send(NORTE_LIVE, { speedMps: 12.5 });
  await restarting;

  // Sin recargar: reconecta solo y el snapshot nuevo reemplaza el estado (trae el punto enviado durante la caída).
  await expect(connectionStatus(page)).toContainText("En vivo", { timeout: 60_000 });
  await expect(vehicleItem(page, NORTE_LIVE)).toContainText("45 km/h");
  // Y vuelven los eventos en vivo.
  await sendUntilShown(page, fleet, NORTE_LIVE, { speedMps: 17.5 }, "63 km/h");
});
