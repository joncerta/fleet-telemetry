import { PAIRING_CODE_ALPHABET, PAIRING_CODE_LENGTH } from "@fleet/contracts";
import { NORTE_USER } from "./support/env";
import { connectionStatus, expect, login, NORTE_LIVE, test, vehicleItem } from "./support/fixtures";

// El formato sale del contrato (`pairingCodeSchema`): 8 caracteres del alfabeto sin ambiguos (sin I, O, 0 ni 1).
const CODE_FORMAT = new RegExp(`^[${PAIRING_CODE_ALPHABET}]{${String(PAIRING_CODE_LENGTH)}}$`);

test("vinculación de dispositivo: el operador elige un vehículo y obtiene un código con el formato del contrato y su vencimiento", async ({
  page,
  env,
  fleet,
}) => {
  await fleet.send(NORTE_LIVE, { speedMps: 5 });
  await login(page, NORTE_USER, env.SEED_USER_PASSWORD);
  await expect(connectionStatus(page)).toContainText("En vivo");
  await expect(vehicleItem(page, NORTE_LIVE)).toBeVisible();

  const panel = page.getByRole("region", { name: "Vincular dispositivo" });
  const generate = panel.getByRole("button", { name: "Generar código" });
  // Sin vehículo elegido no se puede generar.
  await expect(generate).toBeDisabled();

  await panel.getByLabel("Vehículo").selectOption({ label: NORTE_LIVE });
  await expect(generate).toBeEnabled();
  await generate.click();

  await expect(panel.getByText(`Código para ${NORTE_LIVE}`)).toBeVisible();
  await expect(panel.getByText(CODE_FORMAT)).toBeVisible();
  await expect(panel.getByText(/Vence a las/)).toBeVisible();
  await expect(panel.getByRole("alert")).toHaveCount(0);
});
