import { randomBytes } from "node:crypto";
import { PAIRING_CODE_ALPHABET, PAIRING_CODE_LENGTH } from "@fleet/contracts";
import type { Page } from "@playwright/test";
import { NORTE_USER } from "./support/env";
import { connectionStatus, expect, login, openPanel, test } from "./support/fixtures";

const CODE_FORMAT = new RegExp(`^[${PAIRING_CODE_ALPHABET}]{${String(PAIRING_CODE_LENGTH)}}$`);

/** Placa única por corrida (alfanumérica, sin guion): el test se repite sobre una base con historial. */
const uniquePlate = (): string => `E2E${randomBytes(4).toString("hex").toUpperCase()}`;

async function openNewVehicleForm(page: Page) {
  await openPanel(page, "Vincular dispositivo");
  const panel = page.getByRole("region", { name: "Vincular dispositivo" });
  await panel.getByLabel("Vehículo").selectOption({ label: "Nuevo vehículo" });
  return panel;
}

test("nuevo vehículo: placa y nombre crean el vehículo y generan el código en el mismo paso; queda en el catálogo", async ({ page, env, stack: _stack }) => {
  const plate = uniquePlate();
  await login(page, NORTE_USER, env.SEED_USER_PASSWORD);
  await expect(connectionStatus(page)).toContainText("En vivo");
  const panel = await openNewVehicleForm(page);

  await panel.getByLabel("Placa").fill(plate.toLowerCase());
  await panel.getByLabel("Nombre").fill("Camión de prueba e2e");
  await panel.getByRole("button", { name: "Crear y generar código" }).click();

  await expect(panel.getByText(`Código para ${plate}`)).toBeVisible();
  await expect(panel.getByText(CODE_FORMAT)).toBeVisible();
  await expect(panel.getByText(/Vence a las/)).toBeVisible();
  await expect(panel.getByRole("alert")).toHaveCount(0);
  // El catálogo se refrescó: el vehículo nuevo aparece con su nombre (sin dispositivo: el código aún no se canjeó en el móvil).
  await expect(panel.getByRole("option", { name: `${plate} — Camión de prueba e2e` })).toHaveCount(1);
});

test("placa repetida: el servidor la rechaza y la pantalla lo dice sin generar otro código", async ({ page, env, stack: _stack }) => {
  const plate = uniquePlate();
  await login(page, NORTE_USER, env.SEED_USER_PASSWORD);
  await expect(connectionStatus(page)).toContainText("En vivo");
  const panel = await openNewVehicleForm(page);

  // `E2E-xxxx` se guarda en su forma canónica (`E2Exxxx`): el código se muestra con la placa que devolvió el servidor.
  await panel.getByLabel("Placa").fill(`E2E-${plate.slice(3)}`);
  await panel.getByRole("button", { name: "Crear y generar código" }).click();
  await expect(panel.getByText(`Código para ${plate}`)).toBeVisible();

  // La misma placa con otro formato (minúsculas, sin guion): es la misma placa canónica, así que el servidor la rechaza.
  await panel.getByLabel("Vehículo").selectOption({ label: "Nuevo vehículo" });
  await panel.getByLabel("Placa").fill(plate.toLowerCase());
  await panel.getByRole("button", { name: "Crear y generar código" }).click();
  await expect(panel.getByRole("alert")).toHaveText("Ya existe un vehículo con esa placa.");
  await expect(panel.getByText(CODE_FORMAT)).toHaveCount(0);
});

test("placa inválida: se avisa antes de enviar, sin tocar el servidor", async ({ page, env, stack: _stack }) => {
  await login(page, NORTE_USER, env.SEED_USER_PASSWORD);
  const panel = await openNewVehicleForm(page);
  let posted = false;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/v1/vehicles")) posted = true;
  });

  await panel.getByRole("button", { name: "Crear y generar código" }).click();
  await expect(panel.getByRole("alert")).toHaveText("Escribe la placa.");
  await panel.getByLabel("Placa").fill("AB#1");
  await panel.getByRole("button", { name: "Crear y generar código" }).click();
  await expect(panel.getByRole("alert")).toContainText("La placa solo lleva letras y dígitos");
  expect(posted).toBe(false);
});

test("usuarios: el panel lista al operador de Norte y nada de Sur", async ({ page, env, stack: _stack }) => {
  await login(page, NORTE_USER, env.SEED_USER_PASSWORD);
  await openPanel(page, "Usuarios");
  const list = page.getByRole("list", { name: "Usuarios" });
  await expect(list.getByRole("listitem").filter({ hasText: "Operador Norte" })).toContainText(NORTE_USER);
  await expect(page.getByText(/sur\.test/)).toHaveCount(0);
  await expect(page.getByText("Operador Sur")).toHaveCount(0);
});
